import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

/* ---- 迷你软件光栅 Canvas(无抗锯齿, 确定性; clip 支持多子路径并集) ---- */
function hexToRgb(c) {
  return [parseInt(c.slice(1, 3), 16), parseInt(c.slice(3, 5), 16), parseInt(c.slice(5, 7), 16)];
}
function intersectRect(a, b) {
  const x = Math.max(a.x, b.x), y = Math.max(a.y, b.y);
  return { x, y, w: Math.max(0, Math.min(a.x + a.w, b.x + b.w) - x), h: Math.max(0, Math.min(a.y + a.h, b.y + b.h) - y) };
}
class MiniCtx {
  constructor(canvas) { this.canvas = canvas; this._clips = null; this._stack = []; this._path = []; this.fillStyle = '#000000'; }
  setTransform() {}
  save() { this._stack.push(this._clips); }
  restore() { this._clips = this._stack.length ? this._stack.pop() : null; }
  beginPath() { this._path = []; }
  rect(x, y, w, h) { this._path.push({ t: 'r', x, y, w, h }); }
  moveTo(x, y) { this._path.push({ t: 'p', pts: [[x, y]] }); }
  lineTo(x, y) { this._path[this._path.length - 1].pts.push([x, y]); }
  closePath() {}
  ellipse(cx, cy, rx, ry) { this._path.push({ t: 'e', cx, cy, rx, ry }); }
  clip() {
    // 真实 canvas: 同一 path 内多个子路径取并集, 再与已有 clip 取交集
    const rects = this._path.filter(p => p.t === 'r').map(p => ({ x: p.x, y: p.y, w: p.w, h: p.h }));
    if (!this._clips) { this._clips = rects; return; }
    const next = [];
    for (const a of this._clips) for (const b of rects) {
      const r = intersectRect(a, b);
      if (r.w > 0 && r.h > 0) next.push(r);
    }
    this._clips = next;
  }
  _inClip(px, py) {
    if (!this._clips) return true;
    return this._clips.some(r => px >= r.x && px < r.x + r.w && py >= r.y && py < r.y + r.h);
  }
  _bbox(rect) {
    const full = { x: 0, y: 0, w: this.canvas.width, h: this.canvas.height };
    let r = intersectRect(rect, full);
    if (this._clips && this._clips.length) {
      const cb = this._clips.reduce((a, b) => ({
        x: Math.min(a.x, b.x), y: Math.min(a.y, b.y),
        w: 0, h: 0,
      }));
      // 计算 clips 的包围盒
      const x0 = Math.min(...this._clips.map(c => c.x)), y0 = Math.min(...this._clips.map(c => c.y));
      const x1 = Math.max(...this._clips.map(c => c.x + c.w)), y1 = Math.max(...this._clips.map(c => c.y + c.h));
      r = intersectRect(r, { x: x0, y: y0, w: x1 - x0, h: y1 - y0 });
    }
    return { x0: Math.max(0, Math.floor(r.x)), y0: Math.max(0, Math.floor(r.y)), x1: Math.min(this.canvas.width, Math.ceil(r.x + r.w)), y1: Math.min(this.canvas.height, Math.ceil(r.y + r.h)) };
  }
  _put(x, y, rgb) {
    const i = (y * this.canvas.width + x) * 4, d = this.canvas._data;
    d[i] = rgb[0]; d[i + 1] = rgb[1]; d[i + 2] = rgb[2]; d[i + 3] = 255;
  }
  clearRect(x, y, w, h) {
    const r = this._bbox({ x, y, w, h }), d = this.canvas._data, W = this.canvas.width;
    for (let yy = r.y0; yy < r.y1; yy++) for (let xx = r.x0; xx < r.x1; xx++) {
      if (!this._inClip(xx + 0.5, yy + 0.5)) continue;
      const i = (yy * W + xx) * 4; d[i] = d[i + 1] = d[i + 2] = d[i + 3] = 0;
    }
  }
  fillRect(x, y, w, h) {
    const r = this._bbox({ x, y, w, h }), rgb = hexToRgb(this.fillStyle);
    for (let yy = r.y0; yy < r.y1; yy++) for (let xx = r.x0; xx < r.x1; xx++) {
      if (this._inClip(xx + 0.5, yy + 0.5)) this._put(xx, yy, rgb);
    }
  }
  fill() {
    const rgb = hexToRgb(this.fillStyle);
    for (const p of this._path) {
      let bbox;
      if (p.t === 'r') bbox = p;
      else if (p.t === 'e') bbox = { x: p.cx - p.rx, y: p.cy - p.ry, w: p.rx * 2, h: p.ry * 2 };
      else { const xs = p.pts.map(q => q[0]), ys = p.pts.map(q => q[1]);
        bbox = { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) }; }
      const r = this._bbox(bbox);
      for (let yy = r.y0; yy < r.y1; yy++) for (let xx = r.x0; xx < r.x1; xx++) {
        const px = xx + 0.5, py = yy + 0.5;
        if (!this._inClip(px, py)) continue;
        let inside = false;
        if (p.t === 'r') inside = px >= p.x && px < p.x + p.w && py >= p.y && py < p.y + p.h;
        else if (p.t === 'e') inside = ((px - p.cx) / p.rx) ** 2 + ((py - p.cy) / p.ry) ** 2 <= 1;
        else {
          const [a, b, c] = p.pts;
          const d = (b[1] - c[1]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[1] - c[1]);
          const l1 = ((b[1] - c[1]) * (px - c[0]) + (c[0] - b[0]) * (py - c[1])) / d;
          const l2 = ((c[1] - a[1]) * (px - c[0]) + (a[0] - c[0]) * (py - c[1])) / d;
          const l3 = 1 - l1 - l2;
          inside = l1 >= 0 && l2 >= 0 && l3 >= 0;
        }
        if (inside) this._put(xx, yy, rgb);
      }
    }
  }
  drawImage(src, dx, dy) {
    const r = this._bbox({ x: dx, y: dy, w: src.width, h: src.height });
    const W = this.canvas.width;
    for (let yy = r.y0; yy < r.y1; yy++) for (let xx = r.x0; xx < r.x1; xx++) {
      if (!this._inClip(xx + 0.5, yy + 0.5)) continue;
      const si = ((yy - dy) * src.width + (xx - dx)) * 4, di = (yy * W + xx) * 4;
      const s = src._data, d = this.canvas._data;
      if (s[si + 3] === 0) continue;
      d[di] = s[si]; d[di + 1] = s[si + 1]; d[di + 2] = s[si + 2]; d[di + 3] = 255;
    }
  }
  getImageData(x, y, w, h) {
    const out = new Uint8ClampedArray(w * h * 4), W = this.canvas.width, d = this.canvas._data;
    for (let yy = 0; yy < h; yy++) for (let xx = 0; xx < w; xx++) {
      const si = ((y + yy) * W + (x + xx)) * 4, di = (yy * w + xx) * 4;
      out[di] = d[si]; out[di + 1] = d[si + 1]; out[di + 2] = d[si + 2]; out[di + 3] = d[si + 3];
    }
    return { data: out };
  }
}
class MiniCanvas {
  constructor() { this.width = 300; this.height = 300; this._data = null; }
  getContext() { if (!this._data) this._data = new Uint8ClampedArray(this.width * this.height * 4); return new MiniCtx(this); }
}
global.document = { createElement: () => new MiniCanvas() };

/* ---- 加载被测代码 ---- */
eval(fs.readFileSync(path.join(ROOT, 'js/renderer.js'), 'utf8') +
  ';Object.assign(globalThis,{sortByZ,mergeRects,fullRender,LayeredRenderer,verifyAgainstFull,canvasChecksum});');

let pass = 0, fail = 0;
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log('PASS', name, detail); }
  else { fail++; console.log('FAIL', name, detail); }
}

/* 1. z-order */
const arr = [];
for (let i = 0; i < 1000; i++) arr.push({ id: i, z: Math.floor(Math.random() * 100) });
const sorted = sortByZ(arr);
let ok = true;
for (let i = 1; i < sorted.length; i++) {
  const a = sorted[i - 1], b = sorted[i];
  if (a.z > b.z || (a.z === b.z && a.id > b.id)) ok = false;
}
check('z-order 排序', ok);

/* 2. 脏矩形合并 */
const m1 = mergeRects([{ x: 0, y: 0, w: 10, h: 10 }, { x: 5, y: 5, w: 10, h: 10 }, { x: 100, y: 100, w: 5, h: 5 }]);
check('合并: 相交合并', m1.length === 2 && m1.some(r => r.x === 0 && r.y === 0 && r.w === 15 && r.h === 15));
const many = []; for (let i = 0; i < 200; i++) many.push({ x: i * 3, y: 0, w: 1, h: 1 });
const m2 = mergeRects(many, 64);
check('合并: 超限降级包围盒', m2.length === 1 && m2[0].w === 200 * 3 - 2);
const m3 = mergeRects([{ x: 0, y: 0, w: 5, h: 5 }, { x: 10, y: 0, w: 5, h: 5 }]);
check('合并: 不相交保留', m3.length === 2);

/* 3. 随机场景等价性(含变层/降级/逐出) */
function randScene(n, W, H) {
  const objs = [];
  for (let i = 0; i < n; i++) objs.push({
    id: i, x: Math.random() * (W - 40), y: Math.random() * (H - 40),
    w: 10 + Math.random() * 30, h: 10 + Math.random() * 30,
    z: Math.floor(Math.random() * 100),
    color: ['#e6194b', '#3cb44b', '#4363d8', '#f58231'][i % 4], shape: i % 3,
  });
  return objs;
}
function randomUpdates(objs, n, W, H) {
  const ups = [];
  for (let k = 0; k < n; k++) {
    const o = objs[Math.floor(Math.random() * objs.length)];
    const old = { x: o.x, y: o.y, w: o.w, h: o.h, z: o.z };
    o.x = Math.random() * (W - o.w); o.y = Math.random() * (H - o.h);
    if (Math.random() < 0.15) o.z = Math.floor(Math.random() * 100);
    ups.push({ obj: { ...o }, old });
  }
  return ups;
}
function buffersEqual(a, b) {
  if (a._data.length !== b._data.length) return false;
  for (let i = 0; i < a._data.length; i++) if (a._data[i] !== b._data[i]) return false;
  return true;
}
function runEquivalence(name, opts, frames = 60) {
  const W = 320, H = 200;
  const objs = randScene(300, W, H);
  const cA = new MiniCanvas(); cA.width = W; cA.height = H;
  const r = new LayeredRenderer(cA, { layers: opts.layers || 8, threshold: opts.threshold ?? 1, memoryMB: opts.memoryMB ?? 64 });
  r.setObjects(objs.map(o => ({ ...o })));
  for (let f = 0; f < frames; f++) {
    r.applyUpdates(randomUpdates(objs, 80, W, H));
    r.renderFrame('dirty');
  }
  const cB = new MiniCanvas(); cB.width = W; cB.height = H;
  fullRender(cB.getContext('2d'), objs, W, H);
  check(name, buffersEqual(cA, cB),
    `fallbacks=${r.stats.fallbacks} hits=${r.stats.cacheHits} miss=${r.stats.cacheMisses}`);
}
runEquivalence('等价: 常规脏矩形', {});
runEquivalence('等价: 低阈值触发降级', { threshold: 0.05 });
runEquivalence('等价: 内存不足逐出图层', { memoryMB: 0.3 });
runEquivalence('等价: 16 层', { layers: 16 });

/* 4. 图层数动态切换 */
{
  const W = 320, H = 200, objs = randScene(200, W, H);
  const cA = new MiniCanvas(); cA.width = W; cA.height = H;
  const r = new LayeredRenderer(cA, { layers: 4, threshold: 1, memoryMB: 64 });
  r.setObjects(objs.map(o => ({ ...o })));
  for (let f = 0; f < 20; f++) { r.applyUpdates(randomUpdates(objs, 50, W, H)); r.renderFrame('dirty'); }
  r.setLayerCount(12);
  for (let f = 0; f < 20; f++) { r.applyUpdates(randomUpdates(objs, 50, W, H)); r.renderFrame('dirty'); }
  const cB = new MiniCanvas(); cB.width = W; cB.height = H;
  fullRender(cB.getContext('2d'), objs, W, H);
  check('等价: 运行中切换图层数', buffersEqual(cA, cB));
}

/* 5. 背压丢更新(渲染器以本地旧状态为准) */
{
  const W = 320, H = 200, objs = randScene(100, W, H);
  const cA = new MiniCanvas(); cA.width = W; cA.height = H;
  const r = new LayeredRenderer(cA, { layers: 8, threshold: 1, memoryMB: 64 });
  r.setObjects(objs.map(o => ({ ...o })));
  for (let f = 0; f < 30; f++) {
    const ups = randomUpdates(objs, 40, W, H);
    r.applyUpdates(ups.filter(() => Math.random() > 0.3));
    r.renderFrame('dirty');
  }
  const cB = new MiniCanvas(); cB.width = W; cB.height = H;
  fullRender(cB.getContext('2d'), [...r.objects.values()], W, H);
  check('等价: 增量丢失自愈', buffersEqual(cA, cB));
}

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);
