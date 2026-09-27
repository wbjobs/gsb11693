// Web Worker：对象运动模拟线程，与渲染主线程解耦。

import { createScene, stepScene } from './scene.js';

let objects = null;
let width = 0;
let height = 0;
let timer = null;
let lastTime = 0;

function tick() {
  const now = performance.now();
  const dt = Math.min(0.05, (now - lastTime) / 1000);
  lastTime = now;
  const events = stepScene(objects, dt, width, height);

  // 用可转移的 TypedArray 回传位置，避免结构化克隆开销
  const positions = new Float32Array(objects.length * 2);
  for (let i = 0; i < objects.length; i++) {
    positions[i * 2] = objects[i].x;
    positions[i * 2 + 1] = objects[i].y;
  }
  // 事件中的对象状态变化（z/layer/color）一并回传
  const mutations = events
    .filter((e) => e.type !== 'move')
    .map((e) => {
      const o = objects[e.id];
      return { id: e.id, type: e.type, z: o.z, layerId: o.layerId, r: o.r, g: o.g, b: o.b };
    });
  const moves = events.filter((e) => e.type === 'move')
    .map((e) => ({ id: e.id, type: 'move', prev: e.prev }));
  postMessage({ type: 'frame', positions, moves, mutations }, [positions.buffer]);
}

onmessage = (e) => {
  const msg = e.data;
  if (msg.type === 'init') {
    width = msg.width;
    height = msg.height;
    objects = createScene(msg.count, width, height, msg.layerCount);
    postMessage({ type: 'ready', objects });
  } else if (msg.type === 'start') {
    if (timer) clearInterval(timer);
    lastTime = performance.now();
    timer = setInterval(tick, 1000 / 120);
  } else if (msg.type === 'stop') {
    if (timer) clearInterval(timer);
    timer = null;
  }
};
