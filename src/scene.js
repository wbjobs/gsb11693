// 场景模型：对象生成与模拟步进（纯逻辑，主线程与 Worker 共用）。

export const SHAPES = ['rect', 'circle', 'triangle'];

const PALETTE = [
  [231, 76, 60], [52, 152, 219], [46, 204, 113], [241, 196, 15],
  [155, 89, 182], [26, 188, 156], [230, 126, 34], [149, 165, 166],
];

let seqCounter = 0;

export function createScene(count, width, height, layerCount, random = Math.random) {
  const objects = [];
  for (let i = 0; i < count; i++) {
    const w = 20 + random() * 80;
    const h = 20 + random() * 80;
    const layerId = i % layerCount;
    const color = PALETTE[i % PALETTE.length];
    objects.push({
      id: i,
      seq: seqCounter++,
      x: random() * (width - w),
      y: random() * (height - h),
      w, h,
      vx: (random() - 0.5) * 240,
      vy: (random() - 0.5) * 240,
      z: Math.floor(random() * 100),
      layerId,
      shape: SHAPES[i % SHAPES.length],
      r: color[0], g: color[1], b: color[2],
      alpha: 0.55 + random() * 0.45,
      // 图层 0 视为近静态背景层：大部分对象速度为 0
      static: layerId === 0 && random() < 0.85,
    });
  }
  for (const o of objects) if (o.static) { o.vx = 0; o.vy = 0; }
  return objects;
}

/**
 * 模拟步进。返回本帧发生的事件（用于图层缓存失效与脏矩形追踪）。
 * events: [{ id, type: 'move'|'zchange'|'layerchange'|'recolor', prev }]
 */
export function stepScene(objects, dt, width, height, random = Math.random) {
  const events = [];
  for (const o of objects) {
    if (o.vx === 0 && o.vy === 0) continue;
    const prev = { x: o.x, y: o.y, w: o.w, h: o.h };
    o.x += o.vx * dt;
    o.y += o.vy * dt;
    if (o.x < 0) { o.x = 0; o.vx = Math.abs(o.vx); }
    if (o.x + o.w > width) { o.x = width - o.w; o.vx = -Math.abs(o.vx); }
    if (o.y < 0) { o.y = 0; o.vy = Math.abs(o.vy); }
    if (o.y + o.h > height) { o.y = height - o.h; o.vy = -Math.abs(o.vy); }
    events.push({ id: o.id, type: 'move', prev });
  }
  // 低频随机事件：触发 z 变化、图层迁移、变色，用于验证缓存失效路径
  if (random() < 0.05 && objects.length > 0) {
    const o = objects[Math.floor(random() * objects.length)];
    const kind = random();
    if (kind < 0.4) {
      o.z = Math.floor(random() * 100);
      events.push({ id: o.id, type: 'zchange' });
    } else if (kind < 0.7) {
      o.layerId = (o.layerId + 1 + Math.floor(random() * 3)) % 4;
      events.push({ id: o.id, type: 'layerchange' });
    } else {
      const c = PALETTE[Math.floor(random() * PALETTE.length)];
      o.r = c[0]; o.g = c[1]; o.b = c[2];
      events.push({ id: o.id, type: 'recolor' });
    }
  }
  return events;
}

export function boundsOf(o) {
  return { x: o.x, y: o.y, w: o.w, h: o.h };
}
