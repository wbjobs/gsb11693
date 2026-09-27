// 渲染管线验收测试（Node + 软件光栅化 Canvas，运行真实 Renderer 代码）。
// 覆盖验收标准：z-order、脏矩形 vs 全量像素一致、合并正确、图层缓存、
// 缓存失效、内存可控、降级到全量、帧率对照可量化。

import './softcanvas.mjs'; // 注入 globalThis.OffscreenCanvas（须在 renderer 使用前）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Renderer, compareCanvasPixels } from '../src/renderer.js';
import { zsort, isZSorted } from '../src/zsort.js';
import { mergeDirtyRects } from '../src/rects.js';
import { createScene, stepScene } from '../src/scene.js';
import { SoftCanvas } from './softcanvas.mjs';

const W = 240, H = 160, LAYERS = 4, FRAMES = 40;

function runPipeline({ cacheEnabled = true, cacheBudgetBytes, objectCount = 300 } = {}) {
  const objects = createScene(objectCount, W, H, LAYERS);
  const byId = new Map(objects.map((o) => [o.id, o]));
  const renderer = new Renderer(W, H, LAYERS, { cacheEnabled, cacheBudgetBytes });

  const fullCanvas = new SoftCanvas(W, H);
  const dirtyCanvas = new SoftCanvas(W, H);
  renderer.renderFull(fullCanvas.getContext('2d'), objects);
  renderer.renderFull(dirtyCanvas.getContext('2d'), objects);

  let mismatches = 0;
  let fullMs = 0, dirtyMs = 0;
  let sawDegrade = false;

  for (let f = 0; f < FRAMES; f++) {
    const events = stepScene(objects, 1 / 60, W, H);
    renderer.applyEvents(events, byId);
    const dirtyRects = Renderer.dirtyRectsFromEvents(events, byId);

    let t0 = performance.now();
    renderer.renderFull(fullCanvas.getContext('2d'), objects);
    fullMs += performance.now() - t0;

    t0 = performance.now();
    const info = renderer.renderDirty(dirtyCanvas.getContext('2d'), objects, dirtyRects);
    dirtyMs += performance.now() - t0;
    if (info.degraded) sawDegrade = true;

    mismatches += compareCanvasPixels(fullCanvas, dirtyCanvas);
  }
  return { renderer, mismatches, fullMs, dirtyMs, sawDegrade, objects };
}

test('验收1: z-order 排序正确（z 升序，同 z 按 seq 稳定）', () => {
  const objs = createScene(500, W, H, LAYERS);
  const sorted = zsort(objs);
  assert.ok(isZSorted(sorted));
  // 图层内分组排序同样有序（渲染器实际路径）
  const renderer = new Renderer(W, H, LAYERS);
  for (const layer of renderer.groupByLayer(objs)) {
    assert.ok(isZSorted(layer));
  }
});

test('验收2: 脏矩形重绘与全量重绘逐像素一致（40 帧连续模拟）', () => {
  const { mismatches } = runPipeline();
  assert.equal(mismatches, 0);
});

test('验收2b: 关闭图层缓存时脏矩形重绘同样与全量一致', () => {
  const { mismatches } = runPipeline({ cacheEnabled: false });
  assert.equal(mismatches, 0);
});

test('验收3: 帧率对照可量化（输出两种模式的渲染耗时与加速比）', () => {
  const { fullMs, dirtyMs } = runPipeline();
  console.log(`    [benchmark] full=${fullMs.toFixed(1)}ms dirty=${dirtyMs.toFixed(1)}ms ` +
    `speedup=${(fullMs / dirtyMs).toFixed(2)}x (${FRAMES} 帧)`);
  assert.ok(fullMs > 0 && dirtyMs > 0);
  assert.ok(Number.isFinite(fullMs / dirtyMs));
});

test('验收4: 脏矩形合并正确（相交合并、覆盖完整、数量受限）', () => {
  const input = Array.from({ length: 40 }, (_, i) => ({
    x: (i * 61) % (W - 30), y: (i * 37) % (H - 30), w: 25, h: 25,
  }));
  const { rects } = mergeDirtyRects(input, { canvasWidth: W, canvasHeight: H, maxRects: 16 });
  assert.ok(rects.length <= 16);
  assert.ok(rects.length < input.length);
  for (const r of input) {
    const cx = r.x + r.w / 2, cy = r.y + r.h / 2;
    assert.ok(rects.some((m) => cx >= m.x && cx <= m.x + m.w && cy >= m.y && cy <= m.y + m.h),
      `输入矩形 (${r.x},${r.y}) 未被合并结果覆盖`);
  }
});

test('验收5: 图层缓存生效且事件驱动失效正确', () => {
  const { renderer } = runPipeline();
  const s = renderer.cache.stats;
  console.log(`    [cache] hits=${s.hits} misses=${s.misses} invalidations=${s.invalidations} evictions=${s.evictions}`);
  assert.ok(s.hits > 0, '应有缓存命中（静态层复用）');
  assert.ok(s.invalidations > 0, '应有缓存失效（对象移动/变化）');
});

test('验收6: 内存可控（缓存字节数受预算约束，触发 LRU 驱逐）', () => {
  const budget = W * H * 4 * 2; // 仅容 2 个图层
  const renderer = new Renderer(W, H, LAYERS, { cacheBudgetBytes: budget });
  const objs = createScene(200, W, H, LAYERS);
  const layers = renderer.groupByLayer(objs);
  for (let i = 0; i < LAYERS; i++) renderer.layerBitmap(i, layers[i]);
  assert.ok(renderer.cache.totalBytes <= budget + W * H * 4,
    `缓存字节 ${renderer.cache.totalBytes} 超出预算约束`);
  assert.ok(renderer.cache.stats.evictions > 0, '应发生 LRU 驱逐');
});

test('验收7: 脏区域过大时降级为全量重绘', () => {
  const renderer = new Renderer(W, H, LAYERS, { degradeRatio: 0.5 });
  const objs = createScene(100, W, H, LAYERS);
  const canvas = new SoftCanvas(W, H);
  const ctx = canvas.getContext('2d');
  // 构造覆盖 90% 画布的脏矩形
  const bigRects = [];
  for (let i = 0; i < 12; i++) {
    bigRects.push({ x: (i % 4) * 58, y: Math.floor(i / 4) * 50, w: 60, h: 52 });
  }
  const info = renderer.renderDirty(ctx, objs, bigRects);
  assert.equal(info.degraded, true);
  assert.equal(renderer.degradeCount, 1);
});
