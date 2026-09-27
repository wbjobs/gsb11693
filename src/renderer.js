// 渲染器：全量重绘 / 脏矩形局部重绘 / 图层缓存（LRU + 字节预算）。

import { zsort } from './zsort.js';
import { mergeDirtyRects, union, area } from './rects.js';

export function drawObject(ctx, o) {
  ctx.fillStyle = `rgba(${o.r},${o.g},${o.b},${o.alpha})`;
  if (o.shape === 'circle') {
    ctx.beginPath();
    ctx.ellipse(o.x + o.w / 2, o.y + o.h / 2, o.w / 2, o.h / 2, 0, 0, Math.PI * 2);
    ctx.fill();
  } else if (o.shape === 'triangle') {
    ctx.beginPath();
    ctx.moveTo(o.x + o.w / 2, o.y);
    ctx.lineTo(o.x + o.w, o.y + o.h);
    ctx.lineTo(o.x, o.y + o.h);
    ctx.closePath();
    ctx.fill();
  } else {
    ctx.fillRect(o.x, o.y, o.w, o.h);
  }
}

function makeCanvas(width, height) {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(width, height);
  const c = document.createElement('canvas');
  c.width = width; c.height = height;
  return c;
}

export class LayerCache {
  constructor(width, height, budgetBytes = 32 * 1024 * 1024) {
    this.width = width;
    this.height = height;
    this.budgetBytes = budgetBytes;
    this.layers = new Map(); // layerId -> { canvas, ctx, bytes, valid, lastUsed }
    this.totalBytes = 0;
    this.clock = 0;
    this.stats = { hits: 0, misses: 0, evictions: 0, invalidations: 0 };
  }

  get(layerId) {
    const entry = this.layers.get(layerId);
    if (entry && entry.valid) {
      entry.lastUsed = ++this.clock;
      this.stats.hits++;
      return entry;
    }
    this.stats.misses++;
    return null;
  }

  ensure(layerId) {
    let entry = this.layers.get(layerId);
    if (!entry) {
      const canvas = makeCanvas(this.width, this.height);
      const bytes = this.width * this.height * 4;
      entry = { canvas, ctx: canvas.getContext('2d'), bytes, valid: false, lastUsed: 0 };
      this.layers.set(layerId, entry);
      this.totalBytes += bytes;
      this.evictIfNeeded(layerId);
    }
    return entry;
  }

  store(layerId) {
    const entry = this.ensure(layerId);
    entry.valid = true;
    entry.lastUsed = ++this.clock;
    return entry;
  }

  invalidate(layerId) {
    const entry = this.layers.get(layerId);
    if (entry && entry.valid) {
      entry.valid = false;
      this.stats.invalidations++;
    }
  }

  invalidateAll() {
    for (const entry of this.layers.values()) entry.valid = false;
  }

  evictIfNeeded(protectLayerId = null) {
    while (this.totalBytes > this.budgetBytes) {
      let victim = null;
      for (const [id, entry] of this.layers) {
        if (id === protectLayerId) continue;
        if (!victim || entry.lastUsed < victim.entry.lastUsed) victim = { id, entry };
      }
      if (!victim) break;
      this.layers.delete(victim.id);
      this.totalBytes -= victim.entry.bytes;
      this.stats.evictions++;
    }
  }
}

export class Renderer {
  constructor(width, height, layerCount, opts = {}) {
    this.width = width;
    this.height = height;
    this.layerCount = layerCount;
    this.cacheEnabled = opts.cacheEnabled !== false;
    this.cache = new LayerCache(width, height, opts.cacheBudgetBytes);
    this.mergeOpts = {
      maxRects: opts.maxRects ?? 16,
      canvasWidth: width,
      canvasHeight: height,
      degradeRatio: opts.degradeRatio ?? 0.6,
    };
    this.lastDirty = { rects: [], totalArea: 0, degraded: false };
    this.degradeCount = 0;
  }

  groupByLayer(objects) {
    const layers = [];
    for (let i = 0; i < this.layerCount; i++) layers.push([]);
    for (const o of objects) layers[o.layerId % this.layerCount].push(o);
    for (const layer of layers) layer.sort((a, b) => (a.z - b.z) || (a.seq - b.seq));
    return layers;
  }

  renderLayerObjects(ctx, objects) {
    for (const o of objects) drawObject(ctx, o);
  }

  /** 获取某图层的已缓存位图；缓存失效时重绘该层并写回缓存。 */
  layerBitmap(layerId, sortedObjects) {
    if (!this.cacheEnabled) return null;
    let entry = this.cache.get(layerId);
    if (!entry) {
      entry = this.cache.store(layerId);
      entry.ctx.clearRect(0, 0, this.width, this.height);
      this.renderLayerObjects(entry.ctx, sortedObjects);
    }
    return entry.canvas;
  }

  drawLayers(ctx, layers) {
    for (let i = 0; i < layers.length; i++) {
      const bitmap = this.layerBitmap(i, layers[i]);
      if (bitmap) ctx.drawImage(bitmap, 0, 0);
      else this.renderLayerObjects(ctx, layers[i]);
    }
  }

  /** 全量重绘。 */
  renderFull(ctx, objects) {
    const layers = this.groupByLayer(objects);
    ctx.clearRect(0, 0, this.width, this.height);
    this.drawLayers(ctx, layers);
  }

  /**
   * 脏矩形局部重绘。
   * dirtyRects 为对象旧 bounds ∪ 新 bounds 的列表；内部做合并与降级判断。
   * 返回 { degraded, rectCount, coveredArea }。
   */
  renderDirty(ctx, objects, dirtyRects) {
    const merged = mergeDirtyRects(dirtyRects, this.mergeOpts);
    this.lastDirty = merged;
    if (merged.degraded || merged.rects.length === 0 && dirtyRects.length > 0) {
      if (merged.degraded) this.degradeCount++;
      this.renderFull(ctx, objects);
      return { degraded: true, rectCount: 1, coveredArea: this.width * this.height };
    }
    const layers = this.groupByLayer(objects);
    for (const r of merged.rects) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(r.x, r.y, r.w, r.h);
      ctx.clip();
      ctx.clearRect(r.x, r.y, r.w, r.h);
      this.drawLayers(ctx, layers);
      ctx.restore();
    }
    return { degraded: false, rectCount: merged.rects.length, coveredArea: merged.totalArea };
  }

  /** 根据本帧事件更新图层缓存有效性。 */
  applyEvents(events, objectsById) {
    for (const ev of events) {
      const o = objectsById.get(ev.id);
      if (!o) continue;
      if (ev.type === 'layerchange') {
        this.cache.invalidateAll(); // 简化处理：跨层迁移使全部缓存失效
      } else {
        this.cache.invalidate(o.layerId);
      }
    }
  }

  /** 由移动事件生成脏矩形（旧位置 ∪ 新位置）。 */
  static dirtyRectsFromEvents(events, objectsById) {
    const rects = [];
    for (const ev of events) {
      const o = objectsById.get(ev.id);
      if (!o) continue;
      const curr = { x: o.x, y: o.y, w: o.w, h: o.h };
      if (ev.type === 'move' && ev.prev) rects.push(union(ev.prev, curr));
      else rects.push(curr);
    }
    return rects;
  }
}

/** 像素级一致性对比：返回不一致像素数。 */
export function compareCanvasPixels(a, b) {
  if (a.width !== b.width || a.height !== b.height) return Infinity;
  const ctxA = a.getContext('2d');
  const ctxB = b.getContext('2d');
  const dataA = ctxA.getImageData(0, 0, a.width, a.height).data;
  const dataB = ctxB.getImageData(0, 0, b.width, b.height).data;
  let mismatches = 0;
  for (let i = 0; i < dataA.length; i += 4) {
    if (dataA[i] !== dataB[i] || dataA[i + 1] !== dataB[i + 1] ||
        dataA[i + 2] !== dataB[i + 2] || dataA[i + 3] !== dataB[i + 3]) {
      mismatches++;
    }
  }
  return mismatches;
}

export { area, mergeDirtyRects, zsort };
