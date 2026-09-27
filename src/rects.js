// 纯逻辑：矩形运算与脏矩形合并。浏览器与 Node 测试共用。

export function makeRect(x, y, w, h) {
  return { x, y, w, h };
}

export function area(r) {
  return Math.max(0, r.w) * Math.max(0, r.h);
}

export function intersects(a, b) {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

export function union(a, b) {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  const r = Math.max(a.x + a.w, b.x + b.w);
  const bot = Math.max(a.y + a.h, b.y + b.h);
  return makeRect(x, y, r - x, bot - y);
}

export function clampToBounds(r, width, height) {
  const x = Math.max(0, Math.min(r.x, width));
  const y = Math.max(0, Math.min(r.y, height));
  const right = Math.max(0, Math.min(r.x + r.w, width));
  const bottom = Math.max(0, Math.min(r.y + r.h, height));
  return makeRect(x, y, right - x, bottom - y);
}

// 合并代价：并集面积 - 两矩形面积和。<= 0 表示合并不增加额外绘制面积。
function mergeCost(a, b) {
  return area(union(a, b)) - area(a) - area(b);
}

/**
 * 脏矩形合并。
 * 1) 先合并所有相交矩形；
 * 2) 贪心合并代价可接受（slack 以内）的对，并强制满足 maxRects 上限；
 * 3) 降级：合并后总面积占画布比例超过 degradeRatio 时 degraded=true，
 *    调用方应回退为全量重绘。
 */
export function mergeDirtyRects(input, opts = {}) {
  const {
    maxRects = 16,
    slack = 0.25,
    canvasWidth = 0,
    canvasHeight = 0,
    degradeRatio = 0.6,
  } = opts;

  let rects = input
    .filter((r) => r && r.w > 0 && r.h > 0)
    .map((r) => makeRect(r.x, r.y, r.w, r.h));

  if (canvasWidth && canvasHeight) {
    rects = rects
      .map((r) => clampToBounds(r, canvasWidth, canvasHeight))
      .filter((r) => r.w > 0 && r.h > 0);
  }

  // 对齐到整数像素并外扩 1px，避免 clip 边缘抗锯齿导致与全量重绘的像素差异
  rects = rects.map((r) => {
    const x = Math.floor(r.x) - 1;
    const y = Math.floor(r.y) - 1;
    const right = Math.ceil(r.x + r.w) + 1;
    const bottom = Math.ceil(r.y + r.h) + 1;
    const snapped = makeRect(x, y, right - x, bottom - y);
    return canvasWidth && canvasHeight ? clampToBounds(snapped, canvasWidth, canvasHeight) : snapped;
  }).filter((r) => r.w > 0 && r.h > 0);

  let changed = true;
  while (changed) {
    changed = false;
    outer: for (let i = 0; i < rects.length; i++) {
      for (let j = i + 1; j < rects.length; j++) {
        if (intersects(rects[i], rects[j])) {
          rects[i] = union(rects[i], rects[j]);
          rects.splice(j, 1);
          changed = true;
          break outer;
        }
      }
    }
  }

  for (;;) {
    if (rects.length <= 1) break;
    let best = null;
    for (let i = 0; i < rects.length; i++) {
      for (let j = i + 1; j < rects.length; j++) {
        const cost = mergeCost(rects[i], rects[j]);
        const minArea = Math.min(area(rects[i]), area(rects[j]));
        const overLimit = rects.length > maxRects;
        const acceptable = cost <= minArea * slack;
        if (!overLimit && !acceptable) continue;
        if (!best || cost < best.cost) best = { i, j, cost };
      }
    }
    if (!best) break;
    rects[best.i] = union(rects[best.i], rects[best.j]);
    rects.splice(best.j, 1);
  }

  const totalArea = rects.reduce((s, r) => s + area(r), 0);
  const canvasArea = canvasWidth * canvasHeight;
  const degraded = canvasArea > 0 && totalArea > canvasArea * degradeRatio;

  return { rects, totalArea, degraded };
}
