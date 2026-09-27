/* renderer.js — z-order 排序、脏矩形合并、图层缓存渲染器 */
'use strict';

const Z_MAX = 100;

/* ---------- z-order: 画家算法, z 升序, z 相同按 id 升序保证稳定 ---------- */
function sortByZ(objects) {
  return objects.slice().sort((a, b) => (a.z - b.z) || (a.id - b.id));
}

/* ---------- 矩形工具 ---------- */
function rectsIntersect(a, b) {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}
function rectUnion(a, b) {
  const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
  return {
    x, y,
    w: Math.max(a.x + a.w, b.x + b.w) - x,
    h: Math.max(a.y + a.h, b.y + b.h) - y,
  };
}
function rectArea(r) { return Math.max(0, r.w) * Math.max(0, r.h); }
function clampRect(r, w, h) {
  const x = Math.max(0, r.x), y = Math.max(0, r.y);
  return {
    x, y,
    w: Math.max(0, Math.min(w, r.x + r.w) - x),
    h: Math.max(0, Math.min(h, r.y + r.h) - y),
  };
}

/*
 * 脏矩形合并:
 * 1. 反复合并相交矩形, 直到收敛;
 * 2. 若数量仍超过 maxRects, 全部合并为一个包围盒(控制裁剪/内存开销)。
 */
function mergeRects(rects, maxRects = 64) {
  let out = [];
  for (const r of rects) {
    if (r.w <= 0 || r.h <= 0) continue;
    let cur = { x: r.x, y: r.y, w: r.w, h: r.h };
    let merged = true;
    while (merged) {
      merged = false;
      for (let i = 0; i < out.length; i++) {
        if (rectsIntersect(out[i], cur)) {
          cur = rectUnion(out[i], cur);
          out.splice(i, 1);
          merged = true;
          break;
        }
      }
    }
    out.push(cur);
  }
  if (out.length > maxRects) {
    const bbox = out.reduce((acc, r) => rectUnion(acc, r));
    out = [bbox];
  }
  return out;
}

function totalArea(rects) {
  return rects.reduce((s, r) => s + rectArea(r), 0);
}

/* ---------- 对象绘制 ---------- */
function drawObject(ctx, o) {
  ctx.fillStyle = o.color;
  if (o.shape === 0) {
    ctx.fillRect(o.x, o.y, o.w, o.h);
  } else if (o.shape === 1) {
    ctx.beginPath();
    ctx.ellipse(o.x + o.w / 2, o.y + o.h / 2, o.w / 2, o.h / 2, 0, 0, Math.PI * 2);
    ctx.fill();
  } else {
    ctx.beginPath();
    ctx.moveTo(o.x + o.w / 2, o.y);
    ctx.lineTo(o.x + o.w, o.y + o.h);
    ctx.lineTo(o.x, o.y + o.h);
    ctx.closePath();
    ctx.fill();
  }
}

/* ---------- 朴素全量重绘(基准路径, 也用于一致性校验) ---------- */
function fullRender(ctx, objects, w, h) {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, w, h);
  for (const o of sortByZ(objects)) drawObject(ctx, o);
}

/* ---------- 分层 + 脏矩形渲染器 ---------- */
class LayeredRenderer {
  constructor(canvas, opts) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.w = canvas.width;
    this.h = canvas.height;
    this.layerCount = opts.layers || 8;
    this.maxDirtyRects = 64;
    this.fallbackThreshold = opts.threshold || 0.5; // 脏区占比超过则降级全量
    this.memoryBudget = (opts.memoryMB || 64) * 1024 * 1024;

    this.objects = new Map();       // id -> obj
    this.layers = [];               // {objects:Map, canvas, ctx, dirty:[], invalid, cached, lastTouch}
    this._initLayers();

    this.stats = {
      rawRects: 0, mergedRects: 0, dirtyRatio: 0,
      fallbacks: 0, cacheHits: 0, cacheMisses: 0,
      lastFrameFallback: false, memoryBytes: 0,
    };
    this._tick = 0;
  }

  _initLayers() {
    for (const l of this.layers) this._disposeLayer(l);
    this.layers = [];
    for (let i = 0; i < this.layerCount; i++) {
      this.layers.push({
        objects: new Map(), canvas: null, ctx: null,
        dirty: [], invalid: true, cached: true, lastTouch: 0,
      });
    }
  }

  _disposeLayer(l) {
    if (l.canvas) { l.canvas.width = 0; l.canvas.height = 0; }
    l.canvas = null; l.ctx = null;
  }

  layerOf(z) {
    return Math.max(0, Math.min(this.layerCount - 1, Math.floor(z / Z_MAX * this.layerCount)));
  }

  setLayerCount(n) {
    if (n === this.layerCount) return;
    this.layerCount = n;
    const all = [...this.objects.values()];
    this._initLayers();
    this.setObjects(all);
  }

  setObjects(list) {
    this.objects.clear();
    for (const l of this.layers) { l.objects.clear(); l.dirty.length = 0; l.invalid = true; }
    for (const o of list) {
      this.objects.set(o.id, o);
      this.layers[this.layerOf(o.z)].objects.set(o.id, o);
    }
  }

  /* updates: [{obj, old:{x,y,w,h,z}}] — 来自 Worker 的增量 */
  applyUpdates(updates) {
    for (const u of updates) {
      const o = u.obj, old = u.old;
      // 以渲染器本地保存的旧状态为准(Worker 增量可能被背压丢弃)
      const prev = this.objects.get(o.id);
      const oldBox = prev || old;
      const oldLayer = this.layers[this.layerOf(oldBox.z)];
      const newLayer = this.layers[this.layerOf(o.z)];
      // 旧位置脏区(膨胀 2px 覆盖抗锯齿边缘)
      oldLayer.dirty.push(clampRect({ x: oldBox.x - 2, y: oldBox.y - 2, w: oldBox.w + 4, h: oldBox.h + 4 }, this.w, this.h));
      if (oldLayer !== newLayer) {
        oldLayer.objects.delete(o.id);           // 跨层移动: 两个图层都失效
      }
      newLayer.objects.set(o.id, o);             // 同层移动也要更新对象引用
      newLayer.dirty.push(clampRect({ x: o.x - 2, y: o.y - 2, w: o.w + 4, h: o.h + 4 }, this.w, this.h));
      this.objects.set(o.id, o);
    }
  }

  _ensureLayerCanvas(l) {
    if (!l.canvas) {
      l.canvas = document.createElement('canvas');
      l.canvas.width = this.w; l.canvas.height = this.h;
      l.ctx = l.canvas.getContext('2d');
      l.invalid = true;
    }
  }

  /* 内存控制: 超出预算时按 LRU 逐出图层缓存, 该层退化为每帧直绘 */
  _enforceMemoryBudget() {
    const perCanvas = this.w * this.h * 4;
    let used = perCanvas; // 主画布
    for (const l of this.layers) if (l.canvas) used += perCanvas;
    // 预算有富余时, 恢复之前被逐出的层
    for (const l of this.layers) {
      if (!l.cached && used + perCanvas <= this.memoryBudget) {
        l.cached = true; l.invalid = true; used += perCanvas;
      }
    }
    this.stats.memoryBytes = used;
    if (used <= this.memoryBudget) return;
    const cached = this.layers.filter(l => l.canvas).sort((a, b) => a.lastTouch - b.lastTouch);
    while (used > this.memoryBudget && cached.length) {
      const victim = cached.shift();
      this._disposeLayer(victim);
      victim.cached = false; victim.invalid = true; victim.dirty.length = 0;
      used -= perCanvas;
    }
    this.stats.memoryBytes = used;
  }

  /* 渲染一帧。mode: 'dirty' | 'full'。返回本帧是否降级。 */
  renderFrame(mode) {
    this._tick++;
    this._enforceMemoryBudget();
    const screenArea = this.w * this.h;

    if (mode === 'full') {
      // 全量重绘: 不维护图层缓存, 切回脏矩形模式时整层重建
      for (const l of this.layers) { l.invalid = true; l.dirty.length = 0; }
      fullRender(this.ctx, [...this.objects.values()], this.w, this.h);
      this.stats.rawRects = this.stats.mergedRects = 0;
      this.stats.dirtyRatio = 1;
      this.stats.lastFrameFallback = false;
      return false;
    }

    // 1. 合并各层脏矩形, 更新图层缓存
    const globalDirty = [];
    let rawCount = 0;
    for (const l of this.layers) {
      l.lastTouch = this._tick;
      if (!l.cached && !l.canvas) {
        // 被逐出的层: 无缓存, 脏区直接并入全局, 合成时裁剪内直绘
        globalDirty.push(...l.dirty);
        l.dirty.length = 0;
        continue;
      }
      this._ensureLayerCanvas(l);
      if (l.invalid) {
        rawCount += 1;
        globalDirty.push({ x: 0, y: 0, w: this.w, h: this.h });
        l.ctx.setTransform(1, 0, 0, 1, 0, 0);
        l.ctx.clearRect(0, 0, this.w, this.h);
        for (const o of sortByZ([...l.objects.values()])) drawObject(l.ctx, o);
        l.invalid = false; l.dirty.length = 0;
        this.stats.cacheMisses++;
        continue;
      }
      if (!l.dirty.length) { this.stats.cacheHits++; continue; }
      rawCount += l.dirty.length;
      const merged = mergeRects(l.dirty, this.maxDirtyRects);
      l.dirty.length = 0;
      globalDirty.push(...merged);
      const objs = sortByZ([...l.objects.values()]);
      for (const r of merged) {
        l.ctx.save();
        l.ctx.beginPath(); l.ctx.rect(r.x, r.y, r.w, r.h); l.ctx.clip();
        l.ctx.clearRect(r.x, r.y, r.w, r.h);
        for (const o of objs) {
          if (o.x < r.x + r.w && o.x + o.w > r.x && o.y < r.y + r.h && o.y + o.h > r.y) drawObject(l.ctx, o);
        }
        l.ctx.restore();
      }
      this.stats.cacheMisses++;
    }

    // 2. 全局脏矩形合并 + 降级判定
    const mergedGlobal = mergeRects(globalDirty, this.maxDirtyRects);
    const dirtyArea = totalArea(mergedGlobal);
    const ratio = dirtyArea / screenArea;
    this.stats.rawRects = rawCount;
    this.stats.mergedRects = mergedGlobal.length;
    this.stats.dirtyRatio = ratio;

    if (ratio > this.fallbackThreshold) {
      // 降级: 脏区过大, 直接整屏合成(仍利用图层缓存, 跳过重裁剪)
      this.ctx.setTransform(1, 0, 0, 1, 0, 0);
      this.ctx.clearRect(0, 0, this.w, this.h);
      for (const l of this.layers) this._compositeLayer(l, null);
      this.stats.fallbacks++;
      this.stats.lastFrameFallback = true;
      return true;
    }

    // 3. 局部合成: 单次多矩形裁剪, 按层序合成
    this.stats.lastFrameFallback = false;
    if (!mergedGlobal.length) return false;
    this.ctx.save();
    this.ctx.beginPath();
    for (const r of mergedGlobal) this.ctx.rect(r.x, r.y, r.w, r.h);
    this.ctx.clip();
    // 先清空脏区: 图层透明像素经 drawImage 不会覆盖主画布旧内容
    this.ctx.clearRect(0, 0, this.w, this.h);
    for (const l of this.layers) this._compositeLayer(l, mergedGlobal);
    this.ctx.restore();
    return false;
  }

  _compositeLayer(l, clipRects) {
    if (l.canvas) {
      this.ctx.drawImage(l.canvas, 0, 0);
    } else {
      // 缓存被逐出的层: 裁剪内直绘(仅画与脏区相交的对象)
      const objs = sortByZ([...l.objects.values()]);
      for (const o of objs) {
        if (clipRects && !clipRects.some(r =>
          o.x < r.x + r.w && o.x + o.w > r.x && o.y < r.y + r.h && o.y + o.h > r.y)) continue;
        drawObject(this.ctx, o);
      }
    }
  }
}

/* ---------- 一致性校验: 抽样像素对比 ---------- */
function canvasChecksum(canvas, step = 7) {
  const ctx = canvas.getContext('2d');
  const { width, height } = canvas;
  const data = ctx.getImageData(0, 0, width, height).data;
  let hash = 0;
  for (let i = 0; i < data.length; i += 4 * step) {
    hash = ((hash << 5) - hash + data[i] + data[i + 1] * 3 + data[i + 2] * 7 + data[i + 3] * 13) | 0;
  }
  return hash;
}

/* 用朴素全量渲染产出参照, 与主画布对比 */
function verifyAgainstFull(mainCanvas, objects) {
  const ref = document.createElement('canvas');
  ref.width = mainCanvas.width; ref.height = mainCanvas.height;
  fullRender(ref.getContext('2d'), objects, ref.width, ref.height);
  const a = canvasChecksum(mainCanvas), b = canvasChecksum(ref);
  ref.width = 0; ref.height = 0;
  return { pass: a === b, mainHash: a, refHash: b };
}
