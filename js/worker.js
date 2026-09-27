/* worker.js — 对象运动模拟(位置/层级更新), 与渲染线程解耦 */
'use strict';

const Z_MAX = 100;
let objects = [];
let W = 960, H = 600;
let updateRate = 0.2;   // 每 tick 更新的对象比例
let timer = null;
let cursor = 0;         // 轮转游标, 保证每个对象都被公平更新

const COLORS = ['#e6194b','#3cb44b','#4363d8','#f58231','#911eb4','#42d4f4','#f032e6','#bfef45','#469990','#9A6324'];

function rand(a, b) { return a + Math.random() * (b - a); }

function makeObjects(count) {
  objects = [];
  for (let i = 0; i < count; i++) {
    objects.push({
      id: i,
      x: rand(0, W - 40), y: rand(0, H - 40),
      w: rand(12, 48), h: rand(12, 48),
      z: Math.floor(rand(0, Z_MAX)),
      vx: rand(-2.5, 2.5), vy: rand(-2.5, 2.5),
      color: COLORS[i % COLORS.length],
      shape: i % 3,
    });
  }
  cursor = 0;
}

function tick() {
  const n = Math.max(1, Math.floor(objects.length * updateRate));
  const updates = [];
  for (let k = 0; k < n; k++) {
    const o = objects[cursor % objects.length];
    cursor++;
    const old = { x: o.x, y: o.y, w: o.w, h: o.h, z: o.z };
    o.x += o.vx; o.y += o.vy;
    if (o.x < 0 || o.x + o.w > W) { o.vx *= -1; o.x = Math.max(0, Math.min(W - o.w, o.x)); }
    if (o.y < 0 || o.y + o.h > H) { o.vy *= -1; o.y = Math.max(0, Math.min(H - o.h, o.y)); }
    // 少量对象随机变层, 覆盖"图层缓存失效"场景
    if (Math.random() < 0.01) {
      o.z = Math.max(0, Math.min(Z_MAX - 1, o.z + Math.floor(rand(-30, 30))));
    }
    updates.push({ obj: { ...o }, old });
  }
  postMessage({ type: 'tick', updates });
}

self.onmessage = (e) => {
  const m = e.data;
  if (m.type === 'init') {
    W = m.width; H = m.height;
    makeObjects(m.count);
    postMessage({ type: 'objects', objects });
  } else if (m.type === 'config') {
    if (m.updateRate != null) updateRate = m.updateRate;
  } else if (m.type === 'start') {
    if (!timer) timer = setInterval(tick, 16);
  } else if (m.type === 'stop') {
    clearInterval(timer); timer = null;
  }
};
