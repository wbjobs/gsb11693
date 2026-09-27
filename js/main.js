/* main.js — 主线程: 渲染循环、PerformanceObserver、基准对比、UI */
'use strict';

const canvas = document.getElementById('stage');
const W = canvas.width, H = canvas.height;

const ui = {};
['opt-count','opt-count-v','opt-update','opt-update-v','opt-layers','opt-layers-v',
 'opt-threshold','opt-threshold-v','opt-mem','opt-mem-v','btn-mode','btn-bench',
 'btn-verify','opt-autoverify','hud-mode','hud-fps','hud-fallback',
 's-mode','s-fps','s-p95','s-rects','s-ratio','s-fallbacks','s-cache','s-mem',
 's-heap','s-longtask','s-verify','selftest','bench-result','history','btn-clear-db',
].forEach(id => ui[id] = document.getElementById(id));

/* ---------- 渲染器与 Worker ---------- */
let mode = 'dirty';
const renderer = new LayeredRenderer(canvas, {
  layers: +ui['opt-layers'].value,
  threshold: +ui['opt-threshold'].value / 100,
  memoryMB: +ui['opt-mem'].value,
});

// 测试钩子: 预置 __WORKER_SOURCE__ 时用 Blob Worker(便于 file:// 环境测试)
const worker = window.__WORKER_SOURCE__
  ? new Worker(URL.createObjectURL(new Blob([window.__WORKER_SOURCE__], { type: 'text/javascript' })))
  : new Worker('js/worker.js');
let pendingUpdates = [];
let sceneObjects = [];

worker.onmessage = (e) => {
  const m = e.data;
  if (m.type === 'objects') {
    sceneObjects = m.objects;
    renderer.setObjects(m.objects);
  } else if (m.type === 'tick') {
    pendingUpdates.push(...m.updates);
    // 背压保护: 积压超过 4 帧则丢弃最旧的, 避免内存膨胀
    if (pendingUpdates.length > sceneObjects.length * 4) {
      pendingUpdates.splice(0, pendingUpdates.length - sceneObjects.length * 4);
    }
  }
};

function resetScene() {
  pendingUpdates = [];
  worker.postMessage({ type: 'init', count: +ui['opt-count'].value, width: W, height: H });
}
resetScene();
worker.postMessage({ type: 'start' });

/* ---------- PerformanceObserver: 帧耗时测量 + 长任务 ---------- */
const frameDurations = [];       // 最近 600 帧渲染耗时
let longtaskCount = 0;
try {
  const po = new PerformanceObserver((list) => {
    for (const e of list.getEntries()) {
      if (e.entryType === 'measure' && e.name === 'render-frame') {
        frameDurations.push(e.duration);
        if (frameDurations.length > 600) frameDurations.shift();
      } else if (e.entryType === 'longtask') {
        longtaskCount++;
      }
    }
  });
  po.observe({ entryTypes: ['measure', 'longtask'] });
} catch (err) {
  try {
    const po = new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        frameDurations.push(e.duration);
        if (frameDurations.length > 600) frameDurations.shift();
      }
    });
    po.observe({ entryTypes: ['measure'] });
  } catch (e2) { /* 忽略 */ }
}

function p95(arr) {
  if (!arr.length) return 0;
  const s = arr.slice().sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * 0.95))];
}

/* ---------- 主循环 ---------- */
const fpsWindow = [];
let frameCount = 0;
let bench = null; // {phase:'full'|'dirty', t0, frames, durations[], results:{}}

function loop(now) {
  requestAnimationFrame(loop);

  // 应用 Worker 增量
  if (pendingUpdates.length) {
    renderer.applyUpdates(pendingUpdates);
    for (const u of pendingUpdates) sceneObjects[u.obj.id] = u.obj;
    pendingUpdates = [];
  }

  performance.mark('rf-start');
  const fellBack = renderer.renderFrame(bench ? bench.phase : mode);
  performance.mark('rf-end');
  performance.measure('render-frame', 'rf-start', 'rf-end');

  // FPS 滑动窗口
  fpsWindow.push(now);
  while (fpsWindow.length && fpsWindow[0] < now - 1000) fpsWindow.shift();

  // 基准测试采样
  if (bench) {
    bench.frames++;
    if (now - bench.t0 >= 5000) benchNextPhase(now);
  }

  // 自动一致性校验(仅脏矩形模式)
  frameCount++;
  if (ui['opt-autoverify'].checked && !bench && mode === 'dirty' && frameCount % 60 === 0) {
    runVerify();
  }

  updateHUD(fellBack);
  if (frameCount % 15 === 0) updateStats();
}
requestAnimationFrame(loop);

/* ---------- UI 更新 ---------- */
function updateHUD(fellBack) {
  const m = bench ? bench.phase : mode;
  ui['hud-mode'].textContent = '模式: ' + (m === 'dirty' ? '脏矩形' : '全量重绘') + (bench ? ' (测试中)' : '');
  ui['hud-fps'].textContent = 'FPS: ' + fpsWindow.length;
  ui['hud-fallback'].classList.toggle('hidden', !fellBack);
}

function updateStats() {
  const s = renderer.stats;
  ui['s-mode'].textContent = (bench ? bench.phase : mode) === 'dirty' ? '脏矩形' : '全量重绘';
  ui['s-fps'].textContent = fpsWindow.length;
  ui['s-p95'].textContent = p95(frameDurations).toFixed(2) + ' ms';
  ui['s-rects'].textContent = s.rawRects + ' / ' + s.mergedRects;
  ui['s-ratio'].textContent = (s.dirtyRatio * 100).toFixed(1) + '%';
  ui['s-fallbacks'].textContent = s.fallbacks;
  const hits = s.cacheHits, total = s.cacheHits + s.cacheMisses;
  ui['s-cache'].textContent = total ? (hits / total * 100).toFixed(1) + '% (' + hits + '/' + total + ')' : '--';
  ui['s-mem'].textContent = (s.memoryBytes / 1048576).toFixed(1) + ' MB';
  ui['s-heap'].textContent = performance.memory
    ? (performance.memory.usedJSHeapSize / 1048576).toFixed(1) + ' MB' : 'N/A';
  ui['s-longtask'].textContent = longtaskCount;
}

/* ---------- 一致性校验 ---------- */
function runVerify() {
  const r = verifyAgainstFull(canvas, sceneObjects.filter(Boolean));
  ui['s-verify'].textContent = r.pass ? 'PASS (hash=' + r.mainHash + ')' : 'FAIL (' + r.mainHash + ' != ' + r.refHash + ')';
  ui['s-verify'].className = r.pass ? 'good' : 'bad';
  return r.pass;
}
ui['btn-verify'].onclick = runVerify;

/* ---------- 基准对比: 全量 5s → 脏矩形 5s ---------- */
function benchNextPhase(now) {
  const durations = frameDurations.slice(bench.startLen);
  const r = {
    mode: bench.phase,
    frames: bench.frames,
    avgFps: (bench.frames / ((now - bench.t0) / 1000)).toFixed(1),
    p95ms: p95(durations).toFixed(2),
    objects: +ui['opt-count'].value,
    updateRate: +ui['opt-update'].value + '%',
  };
  bench.results[bench.phase] = r;
  BenchDB.save({ ...r, avgFps: +r.avgFps, p95ms: +r.p95ms }).then(loadHistory);

  if (bench.phase === 'full') {
    bench = { phase: 'dirty', t0: now, frames: 0, startLen: frameDurations.length, results: bench.results };
  } else {
    const f = bench.results.full, d = bench.results.dirty;
    const gain = ((d.avgFps / f.avgFps - 1) * 100).toFixed(1);
    ui['bench-result'].innerHTML =
      '全量重绘: ' + f.avgFps + ' FPS, P95 ' + f.p95ms + ' ms\n' +
      '脏矩形  : ' + d.avgFps + ' FPS, P95 ' + d.p95ms + ' ms\n' +
      '提升    : <span class="good">+' + gain + '%</span>';
    bench = null;
    ui['btn-bench'].disabled = false;
    ui['btn-mode'].disabled = false;
  }
}

ui['btn-bench'].onclick = () => {
  if (bench) return;
  bench = { phase: 'full', t0: performance.now(), frames: 0, startLen: frameDurations.length, results: {} };
  ui['btn-bench'].disabled = true;
  ui['btn-mode'].disabled = true;
  ui['bench-result'].textContent = '测试中: 全量重绘阶段(5s)...';
};

/* ---------- 控件 ---------- */
ui['btn-mode'].onclick = () => {
  mode = mode === 'dirty' ? 'full' : 'dirty';
  ui['btn-mode'].textContent = mode === 'dirty' ? '切换到全量重绘' : '切换到脏矩形';
};
ui['opt-count'].oninput = () => { ui['opt-count-v'].textContent = ui['opt-count'].value; };
ui['opt-count'].onchange = resetScene;
ui['opt-update'].oninput = () => {
  ui['opt-update-v'].textContent = ui['opt-update'].value + '%';
  worker.postMessage({ type: 'config', updateRate: +ui['opt-update'].value / 100 });
};
ui['opt-layers'].oninput = () => { ui['opt-layers-v'].textContent = ui['opt-layers'].value; };
ui['opt-layers'].onchange = () => renderer.setLayerCount(+ui['opt-layers'].value);
ui['opt-threshold'].oninput = () => {
  ui['opt-threshold-v'].textContent = ui['opt-threshold'].value + '%';
  renderer.fallbackThreshold = +ui['opt-threshold'].value / 100;
};
ui['opt-mem'].oninput = () => {
  ui['opt-mem-v'].textContent = ui['opt-mem'].value;
  renderer.memoryBudget = +ui['opt-mem'].value * 1048576;
};
worker.postMessage({ type: 'config', updateRate: +ui['opt-update'].value / 100 });

/* ---------- IndexedDB 历史 ---------- */
async function loadHistory() {
  const rows = await BenchDB.all();
  const tbody = ui['history'].querySelector('tbody');
  tbody.innerHTML = rows.slice(0, 20).map(r =>
    '<tr><td>' + new Date(r.ts).toLocaleTimeString() + '</td><td>' +
    (r.mode === 'dirty' ? '脏矩形' : '全量') + '</td><td>' + r.objects +
    '</td><td>' + r.updateRate + '</td><td>' + r.avgFps + '</td><td>' + r.p95ms + '</td></tr>'
  ).join('');
}
ui['btn-clear-db'].onclick = async () => { await BenchDB.clear(); loadHistory(); };
loadHistory();

/* ---------- 自检 ---------- */
function addTestResult(name, pass, detail) {
  const li = document.createElement('li');
  li.className = pass ? 'pass' : 'fail';
  li.textContent = (pass ? '✓ ' : '✗ ') + name + (detail ? ' — ' + detail : '');
  ui['selftest'].appendChild(li);
}

function selfTests() {
  // 1. z-order 排序正确性
  const arr = [];
  for (let i = 0; i < 500; i++) arr.push({ id: i, z: Math.floor(Math.random() * 100) });
  const sorted = sortByZ(arr);
  let ok = true;
  for (let i = 1; i < sorted.length; i++) {
    const a = sorted[i - 1], b = sorted[i];
    if (a.z > b.z || (a.z === b.z && a.id > b.id)) { ok = false; break; }
  }
  addTestResult('z-order 排序', ok, '500 个随机对象, 检查 (z,id) 单调性');

  // 2. 脏矩形合并
  const merged = mergeRects([
    { x: 0, y: 0, w: 10, h: 10 }, { x: 5, y: 5, w: 10, h: 10 }, { x: 100, y: 100, w: 5, h: 5 },
  ]);
  const mergeOk = merged.length === 2 &&
    merged.some(r => r.x === 0 && r.y === 0 && r.w === 15 && r.h === 15);
  const many = [];
  for (let i = 0; i < 200; i++) many.push({ x: i * 3, y: 0, w: 1, h: 1 });
  const capped = mergeRects(many, 64);
  addTestResult('脏矩形合并', mergeOk && capped.length === 1,
    '相交合并为 2 个; 200 个分散矩形超限合并为包围盒');

  // 3. 脏矩形 vs 全量渲染等价性(离线双画布)
  const cA = document.createElement('canvas'); cA.width = 320; cA.height = 200;
  const rA = new LayeredRenderer(cA, { layers: 6, threshold: 1, memoryMB: 64 });
  const objs = [];
  for (let i = 0; i < 200; i++) {
    objs.push({
      id: i, x: Math.random() * 280, y: Math.random() * 160,
      w: 10 + Math.random() * 30, h: 10 + Math.random() * 30,
      z: Math.floor(Math.random() * 100),
      color: ['#e6194b', '#3cb44b', '#4363d8'][i % 3], shape: i % 3,
    });
  }
  rA.setObjects(objs);
  rA.renderFrame('dirty');
  for (let f = 0; f < 30; f++) {
    const ups = [];
    for (let k = 0; k < 40; k++) {
      const o = objs[Math.floor(Math.random() * objs.length)];
      const old = { x: o.x, y: o.y, w: o.w, h: o.h, z: o.z };
      o.x = Math.random() * 280; o.y = Math.random() * 160;
      if (Math.random() < 0.2) o.z = Math.floor(Math.random() * 100);
      ups.push({ obj: { ...o }, old });
    }
    rA.applyUpdates(ups);
    rA.renderFrame('dirty');
  }
  const eq = verifyAgainstFull(cA, objs);
  addTestResult('脏矩形/全量等价', eq.pass, '200 对象 × 30 帧随机更新后像素哈希对比');
  cA.width = 0; cA.height = 0;
}
selfTests();
