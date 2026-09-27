// 主线程：渲染循环、模式切换、基准对照、一致性校验、指标持久化。

import { Renderer, compareCanvasPixels } from './renderer.js';
import { FPSMeter, PerfMonitor } from './metrics.js';
import { openDB, saveRun, saveSample, getAllRuns, clearAll } from './db.js';

const WIDTH = 960;
const HEIGHT = 600;
const LAYER_COUNT = 4;

const canvas = document.getElementById('stage');
canvas.width = WIDTH;
canvas.height = HEIGHT;
const ctx = canvas.getContext('2d');

const ui = {
  mode: document.getElementById('mode'),
  count: document.getElementById('objCount'),
  countLabel: document.getElementById('objCountLabel'),
  cacheToggle: document.getElementById('cacheToggle'),
  budget: document.getElementById('cacheBudget'),
  degradeRatio: document.getElementById('degradeRatio'),
  benchBtn: document.getElementById('benchBtn'),
  checkBtn: document.getElementById('checkBtn'),
  clearBtn: document.getElementById('clearBtn'),
  fpsFull: document.getElementById('fpsFull'),
  fpsDirty: document.getElementById('fpsDirty'),
  status: document.getElementById('status'),
  memInfo: document.getElementById('memInfo'),
  cacheInfo: document.getElementById('cacheInfo'),
  dirtyInfo: document.getElementById('dirtyInfo'),
  checkResult: document.getElementById('checkResult'),
  longTasks: document.getElementById('longTasks'),
  chart: document.getElementById('chart'),
  log: document.getElementById('log'),
};

let objects = [];
let objectsById = new Map();
let renderer = new Renderer(WIDTH, HEIGHT, LAYER_COUNT, {
  cacheBudgetBytes: Number(ui.budget.value) * 1024 * 1024,
  degradeRatio: Number(ui.degradeRatio.value),
});
let pendingEvents = [];
let pendingDirtyRects = [];
let sceneDirty = true;
let needsFullRender = true;

const meters = { full: new FPSMeter(), dirty: new FPSMeter() };
const monitor = new PerfMonitor();
monitor.start();

let db = null;
openDB().then((d) => { db = d; refreshChart(); }).catch((e) => log(`IndexedDB 打开失败: ${e.message}`));

function log(msg) {
  const line = document.createElement('div');
  line.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
  ui.log.prepend(line);
  while (ui.log.children.length > 50) ui.log.lastChild.remove();
}

// ---------- Worker ----------
let worker = null;

function startWorker(count) {
  if (worker) worker.terminate();
  worker = new Worker('./src/worker.js', { type: 'module' });
  worker.onmessage = (e) => {
    const msg = e.data;
    if (msg.type === 'ready') {
      objects = msg.objects;
      objectsById = new Map(objects.map((o) => [o.id, o]));
      renderer.cache.invalidateAll();
      sceneDirty = true;
      needsFullRender = true;
      worker.postMessage({ type: 'start' });
      log(`场景就绪：${objects.length} 个对象，${LAYER_COUNT} 个图层`);
    } else if (msg.type === 'frame') {
      const pos = msg.positions;
      for (let i = 0; i < objects.length; i++) {
        objects[i].x = pos[i * 2];
        objects[i].y = pos[i * 2 + 1];
      }
      for (const m of msg.mutations) {
        const o = objectsById.get(m.id);
        if (!o) continue;
        o.z = m.z; o.layerId = m.layerId; o.r = m.r; o.g = m.g; o.b = m.b;
      }
      const events = [...msg.moves, ...msg.mutations];
      pendingEvents.push(...events);
      sceneDirty = true;
    }
  };
  worker.postMessage({ type: 'init', count, width: WIDTH, height: HEIGHT, layerCount: LAYER_COUNT });
}

// ---------- 渲染循环 ----------
let frameCount = 0;
const CHECK_EVERY = 120;

function frame(now) {
  requestAnimationFrame(frame);
  if (!sceneDirty || objects.length === 0) return;

  const mode = ui.mode.value;
  const events = pendingEvents;
  pendingEvents = [];

  // 图层缓存失效
  renderer.applyEvents(events, objectsById);
  // 由事件生成脏矩形（旧 ∪ 新）
  const dirtyRects = Renderer.dirtyRectsFromEvents(events, objectsById);
  pendingDirtyRects = dirtyRects;

  // 脏矩形模式下无脏区域且已完成首帧全量 => 画面无变化，跳过渲染
  const skipRender = mode === 'dirty' && !needsFullRender && dirtyRects.length === 0;
  if (!skipRender) {
    const meter = meters[mode];
    monitor.measureRender(mode, () => {
      if (mode === 'dirty' && !needsFullRender) {
        renderer.renderDirty(ctx, objects, dirtyRects);
      } else {
        renderer.renderFull(ctx, objects);
      }
    });
    meter.tick(now);
    needsFullRender = false;
  }
  frameCount++;

  if (frameCount % CHECK_EVERY === 0 && dirtyRects.length > 0) {
    runConsistencyCheck(dirtyRects, true);
  }
  if (frameCount % 30 === 0) updateHud();
  if (frameCount % 60 === 0 && db) {
    saveSample(db, { mode, fps: meter.fps, frameMs: meter.avgFrameMs }).catch(() => {});
  }
  sceneDirty = pendingEvents.length > 0;
}

// ---------- 一致性校验：脏矩形结果必须逐像素等于全量重绘 ----------
function makeCheckCanvas() {
  const c = typeof OffscreenCanvas !== 'undefined'
    ? new OffscreenCanvas(WIDTH, HEIGHT)
    : Object.assign(document.createElement('canvas'), { width: WIDTH, height: HEIGHT });
  return c;
}

function runConsistencyCheck(dirtyRects, automatic = false) {
  const a = makeCheckCanvas();
  renderer.renderFull(a.getContext('2d'), objects);
  let mismatches;
  if (ui.mode.value === 'dirty' && !needsFullRender) {
    // 视口画布本身就是增量脏矩形产物，直接与全量结果对比（最强校验）
    mismatches = compareCanvasPixels(canvas, a);
  } else {
    // 全量模式下：在离屏画布上验证「全量基底 + 脏矩形增量」与纯全量一致
    const b = makeCheckCanvas();
    const bctx = b.getContext('2d');
    renderer.renderFull(bctx, objects);
    renderer.renderDirty(bctx, objects, dirtyRects);
    mismatches = compareCanvasPixels(a, b);
  }
  const ok = mismatches === 0;
  ui.checkResult.textContent = ok
    ? `一致性：PASS（0 像素差异）`
    : `一致性：FAIL（${mismatches} 像素不同）`;
  ui.checkResult.className = ok ? 'pass' : 'fail';
  if (!ok || !automatic) log(`一致性校验 ${ok ? 'PASS' : `FAIL (${mismatches}px)`}（${dirtyRects.length} 个脏矩形）`);
  return ok;
}

// ---------- HUD ----------
function fmtBytes(bytes) {
  if (bytes > 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024).toFixed(0)} KB`;
}

function updateHud() {
  ui.fpsFull.textContent = meters.full.fps.toFixed(1);
  ui.fpsDirty.textContent = meters.dirty.fps.toFixed(1);
  const d = renderer.lastDirty;
  const ratio = ((d.totalArea / (WIDTH * HEIGHT)) * 100).toFixed(1);
  ui.dirtyInfo.textContent = `脏矩形 ${d.rects.length} 个，覆盖 ${ratio}%${d.degraded ? '（已降级全量）' : ''}，累计降级 ${renderer.degradeCount} 次`;
  const cs = renderer.cache.stats;
  ui.cacheInfo.textContent = renderer.cacheEnabled
    ? `缓存 ${fmtBytes(renderer.cache.totalBytes)} / 预算 ${fmtBytes(renderer.cache.budgetBytes)}，命中 ${cs.hits} 未命中 ${cs.misses} 失效 ${cs.invalidations} 驱逐 ${cs.evictions}`
    : '图层缓存已关闭';
  if (performance.memory) {
    ui.memInfo.textContent = `JS 堆 ${fmtBytes(performance.memory.usedJSHeapSize)} / ${fmtBytes(performance.memory.jsHeapSizeLimit)}`;
  }
  ui.longTasks.textContent = `长任务 ${monitor.longTasks.length} 个；平均渲染耗时 full ${monitor.avgRenderMs('full').toFixed(2)}ms / dirty ${monitor.avgRenderMs('dirty').toFixed(2)}ms`;
  // 防止 performance measure 缓冲区无限增长（PerfMonitor 已留存所需数据）
  performance.clearMeasures('render-full');
  performance.clearMeasures('render-dirty');
}

// ---------- 基准对照：同一负载下分别跑 full / dirty ----------
async function runBenchmark() {
  ui.benchBtn.disabled = true;
  const seconds = 5;
  const results = {};
  for (const mode of ['full', 'dirty']) {
    ui.mode.value = mode;
    meters[mode].reset();
    ui.status.textContent = `基准运行中：${mode} 模式 ${seconds}s…`;
    await new Promise((r) => setTimeout(r, seconds * 1000));
    results[mode] = {
      fps: meters[mode].fps,
      avgFrameMs: meters[mode].avgFrameMs,
      p95FrameMs: meters[mode].p95FrameMs,
      renderMs: monitor.avgRenderMs(mode),
    };
  }
  const run = {
    objectCount: objects.length,
    cacheEnabled: renderer.cacheEnabled,
    full: results.full,
    dirty: results.dirty,
    // 帧间隔受显示刷新率封顶，渲染耗时（performance.measure）才是有效对照指标
    speedup: results.dirty.renderMs > 0 ? results.full.renderMs / results.dirty.renderMs : 0,
  };
  if (db) await saveRun(db, run).catch(() => {});
  ui.status.textContent = `基准完成：渲染耗时 full ${run.full.renderMs.toFixed(2)}ms / dirty ${run.dirty.renderMs.toFixed(2)}ms，加速比 ${run.speedup.toFixed(2)}x`;
  log(`基准：full ${run.full.fps.toFixed(1)}fps/${run.full.renderMs.toFixed(2)}ms vs dirty ${run.dirty.fps.toFixed(1)}fps/${run.dirty.renderMs.toFixed(2)}ms，${run.speedup.toFixed(2)}x`);
  ui.benchBtn.disabled = false;
  refreshChart();
}

// ---------- 历史对照图 ----------
async function refreshChart() {
  if (!db) return;
  const runs = await getAllRuns(db).catch(() => []);
  const c = ui.chart;
  const cctx = c.getContext('2d');
  cctx.clearRect(0, 0, c.width, c.height);
  if (runs.length === 0) {
    cctx.fillStyle = '#888';
    cctx.fillText('暂无基准数据，点击「运行基准对照」', 10, 20);
    return;
  }
  const recent = runs.slice(-10);
  const maxFps = Math.max(...recent.flatMap((r) => [r.full.fps, r.dirty.fps]), 1);
  const barW = 14;
  const groupW = (c.width - 40) / recent.length;
  recent.forEach((run, i) => {
    const x0 = 30 + i * groupW;
    const hFull = (run.full.fps / maxFps) * (c.height - 40);
    const hDirty = (run.dirty.fps / maxFps) * (c.height - 40);
    cctx.fillStyle = '#e74c3c';
    cctx.fillRect(x0, c.height - 20 - hFull, barW, hFull);
    cctx.fillStyle = '#2ecc71';
    cctx.fillRect(x0 + barW + 2, c.height - 20 - hDirty, barW, hDirty);
    cctx.fillStyle = '#666';
    cctx.fillText(`${run.objectCount}`, x0, c.height - 6);
  });
  cctx.fillStyle = '#e74c3c'; cctx.fillText('■ full', c.width - 110, 14);
  cctx.fillStyle = '#2ecc71'; cctx.fillText('■ dirty', c.width - 60, 14);
}

// ---------- 事件绑定 ----------
ui.count.addEventListener('input', () => { ui.countLabel.textContent = ui.count.value; });
ui.count.addEventListener('change', () => startWorker(Number(ui.count.value)));
ui.cacheToggle.addEventListener('change', () => {
  renderer.cacheEnabled = ui.cacheToggle.checked;
  renderer.cache.invalidateAll();
  log(`图层缓存 ${renderer.cacheEnabled ? '开启' : '关闭'}`);
});
ui.budget.addEventListener('change', () => {
  renderer.cache.budgetBytes = Number(ui.budget.value) * 1024 * 1024;
  renderer.cache.evictIfNeeded();
  log(`缓存预算调整为 ${ui.budget.value} MB`);
});
ui.degradeRatio.addEventListener('change', () => {
  renderer.mergeOpts.degradeRatio = Number(ui.degradeRatio.value);
});
ui.benchBtn.addEventListener('click', runBenchmark);
ui.checkBtn.addEventListener('click', () => {
  const rects = pendingDirtyRects.length > 0
    ? pendingDirtyRects
    : objects.map((o) => ({ x: o.x, y: o.y, w: o.w, h: o.h }));
  runConsistencyCheck(rects);
});
ui.clearBtn.addEventListener('click', async () => {
  if (db) { await clearAll(db); refreshChart(); log('已清空 IndexedDB 历史数据'); }
});

startWorker(Number(ui.count.value));
requestAnimationFrame(frame);
