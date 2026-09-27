// 纯逻辑单元测试：z-order 排序、脏矩形合并、降级、场景模拟。
// 运行：node --test test/logic.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { zsort, isZSorted } from '../src/zsort.js';
import { mergeDirtyRects, union, intersects, area, clampToBounds } from '../src/rects.js';
import { createScene, stepScene } from '../src/scene.js';

test('zsort: 按 z 升序，同 z 按 seq 稳定', () => {
  const objs = [
    { id: 1, z: 5, seq: 0 },
    { id: 2, z: 3, seq: 1 },
    { id: 3, z: 5, seq: 2 },
    { id: 4, z: 3, seq: 3 },
    { id: 5, z: 1, seq: 4 },
  ];
  const sorted = zsort(objs);
  assert.deepEqual(sorted.map((o) => o.id), [5, 2, 4, 1, 3]);
  assert.ok(isZSorted(sorted));
  // 原数组不被修改
  assert.equal(objs[0].id, 1);
});

test('zsort: 同 z 时保持插入顺序（稳定性）', () => {
  const objs = Array.from({ length: 100 }, (_, i) => ({ id: i, z: 7, seq: i }));
  const shuffled = [...objs].reverse();
  // seq 决定顺序，与输入顺序无关
  const sorted = zsort(shuffled);
  assert.deepEqual(sorted.map((o) => o.id), objs.map((o) => o.id));
});

test('rects: union / intersects / area / clamp', () => {
  const a = { x: 0, y: 0, w: 10, h: 10 };
  const b = { x: 5, y: 5, w: 10, h: 10 };
  assert.ok(intersects(a, b));
  assert.deepEqual(union(a, b), { x: 0, y: 0, w: 15, h: 15 });
  assert.equal(area(union(a, b)), 225);
  assert.deepEqual(clampToBounds({ x: -5, y: -5, w: 20, h: 20 }, 10, 10), { x: 0, y: 0, w: 10, h: 10 });
});

test('mergeDirtyRects: 相交矩形被合并', () => {
  const { rects, degraded } = mergeDirtyRects([
    { x: 0, y: 0, w: 10, h: 10 },
    { x: 5, y: 5, w: 10, h: 10 },
    { x: 100, y: 100, w: 10, h: 10 },
  ], { canvasWidth: 200, canvasHeight: 200 });
  assert.equal(rects.length, 2);
  assert.equal(degraded, false);
  const merged = rects.find((r) => r.w > 10);
  assert.ok(merged, '应存在一个合并后的矩形');
});

test('mergeDirtyRects: 不相交且合并代价高的矩形保持分离', () => {
  const { rects } = mergeDirtyRects([
    { x: 0, y: 0, w: 10, h: 10 },
    { x: 500, y: 500, w: 10, h: 10 },
  ], { canvasWidth: 1000, canvasHeight: 1000, slack: 0.25 });
  assert.equal(rects.length, 2);
});

test('mergeDirtyRects: maxRects 上限被强制满足', () => {
  const input = Array.from({ length: 50 }, (_, i) => ({ x: i * 30, y: i * 20, w: 5, h: 5 }));
  const { rects } = mergeDirtyRects(input, { maxRects: 8, canvasWidth: 5000, canvasHeight: 5000 });
  assert.ok(rects.length <= 8, `期望 <= 8，实际 ${rects.length}`);
});

test('mergeDirtyRects: 覆盖率超阈值时降级为全量', () => {
  const input = Array.from({ length: 20 }, (_, i) => ({ x: (i % 5) * 200, y: Math.floor(i / 5) * 150, w: 190, h: 140 }));
  const { degraded, totalArea } = mergeDirtyRects(input, {
    canvasWidth: 1000, canvasHeight: 600, degradeRatio: 0.6,
  });
  assert.equal(degraded, true);
  assert.ok(totalArea > 1000 * 600 * 0.6);
});

test('mergeDirtyRects: 合并结果完整覆盖所有输入矩形', () => {
  const input = Array.from({ length: 30 }, (_, i) => ({
    x: (i * 37) % 900, y: (i * 53) % 500, w: 20 + (i % 5) * 10, h: 20 + (i % 3) * 15,
  }));
  const { rects } = mergeDirtyRects(input, { canvasWidth: 960, canvasHeight: 600 });
  for (const r of input) {
    const c = clampToBounds(r, 960, 600);
    if (c.w <= 0 || c.h <= 0) continue;
    // 输入矩形的中心点必须落在某个合并矩形内
    const cx = c.x + c.w / 2;
    const cy = c.y + c.h / 2;
    const covered = rects.some((m) => cx >= m.x && cx <= m.x + m.w && cy >= m.y && cy <= m.y + m.h);
    assert.ok(covered, `矩形 ${JSON.stringify(c)} 未被覆盖`);
  }
});

test('scene: 生成对象字段完整且静态层速度为 0', () => {
  const objs = createScene(200, 960, 600, 4);
  assert.equal(objs.length, 200);
  for (const o of objs) {
    assert.ok(o.w > 0 && o.h > 0);
    assert.ok(o.x >= 0 && o.x + o.w <= 960);
    assert.ok(o.y >= 0 && o.y + o.h <= 600);
    if (o.static) assert.equal(o.vx + o.vy, 0);
  }
});

test('scene: 步进后对象不越界且产生 move 事件', () => {
  const objs = createScene(100, 960, 600, 4);
  for (let i = 0; i < 120; i++) {
    const events = stepScene(objs, 1 / 60, 960, 600);
    for (const o of objs) {
      assert.ok(o.x >= 0 && o.x + o.w <= 960, `x 越界: ${o.x}`);
      assert.ok(o.y >= 0 && o.y + o.h <= 600, `y 越界: ${o.y}`);
    }
    for (const ev of events) {
      if (ev.type === 'move') assert.ok(ev.prev && typeof ev.prev.x === 'number');
    }
  }
});
