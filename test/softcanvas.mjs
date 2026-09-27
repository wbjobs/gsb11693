// 软件光栅化 Canvas2D 子集：在 Node 中验证真实 Renderer 的像素级行为。
// 实现 Renderer 用到的全部 API：fillRect/clearRect/path fill/rect clip/drawImage/getImageData。
// 无抗锯齿、确定性光栅化 —— 同一渲染路径必然产生同一像素结果。

function parseColor(style) {
  const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/.exec(style);
  if (!m) return [0, 0, 0, 1];
  return [Number(m[1]), Number(m[2]), Number(m[3]), m[4] === undefined ? 1 : Number(m[4])];
}

function pointInPolygon(px, py, poly) {
  // 射线法（even-odd）。Renderer 的形状均为凸多边形，与非零环绕规则等价。
  let inside = false;
  for (let i = 0, j = poly.length - 2; i < poly.length; j = i, i += 2) {
    const xi = poly[i], yi = poly[i + 1];
    const xj = poly[j], yj = poly[j + 1];
    if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

export class SoftContext2D {
  constructor(canvas) {
    this.canvas = canvas;
    this.buf = new Uint8ClampedArray(canvas.width * canvas.height * 4);
    this._fill = [0, 0, 0, 1];
    this._clip = null; // {x,y,w,h} 或 null（无裁剪）
    this._stack = [];
    this._path = [];
    this._current = null;
  }

  set fillStyle(style) { this._fill = parseColor(style); }
  get fillStyle() { return this._fill; }

  save() { this._stack.push(this._clip); }
  restore() { this._clip = this._stack.pop() ?? null; }

  beginPath() { this._path = []; this._current = null; }
  moveTo(x, y) { this._current = [x, y]; this._path.push(this._current); }
  lineTo(x, y) { this._current.push(x, y); }
  closePath() { this._current = null; }
  rect(x, y, w, h) {
    this._path.push([x, y, x + w, y, x + w, y + h, x, y + h]);
  }
  ellipse(cx, cy, rx, ry, _rot, start, end) {
    const segs = 48;
    const poly = [];
    for (let i = 0; i <= segs; i++) {
      const t = start + ((end - start) * i) / segs;
      poly.push(cx + rx * Math.cos(t), cy + ry * Math.sin(t));
    }
    this._path.push(poly);
  }

  _clipBounds() {
    return this._clip ?? { x: 0, y: 0, w: this.canvas.width, h: this.canvas.height };
  }

  _blendPixel(px, py, r, g, b, a) {
    const idx = (py * this.canvas.width + px) * 4;
    const inv = 1 - a;
    this.buf[idx] = r * a + this.buf[idx] * inv;
    this.buf[idx + 1] = g * a + this.buf[idx + 1] * inv;
    this.buf[idx + 2] = b * a + this.buf[idx + 2] * inv;
    this.buf[idx + 3] = 255 * a + this.buf[idx + 3] * inv;
  }

  _fillRegion(x0, y0, x1, y1, coverFn) {
    const clip = this._clipBounds();
    const sx = Math.max(Math.floor(x0), Math.floor(clip.x), 0);
    const sy = Math.max(Math.floor(y0), Math.floor(clip.y), 0);
    const ex = Math.min(Math.ceil(x1), Math.ceil(clip.x + clip.w), this.canvas.width);
    const ey = Math.min(Math.ceil(y1), Math.ceil(clip.y + clip.h), this.canvas.height);
    const [r, g, b, a] = this._fill;
    for (let py = sy; py < ey; py++) {
      for (let px = sx; px < ex; px++) {
        if (coverFn(px + 0.5, py + 0.5)) this._blendPixel(px, py, r, g, b, a);
      }
    }
  }

  fill() {
    for (const poly of this._path) {
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (let i = 0; i < poly.length; i += 2) {
        minX = Math.min(minX, poly[i]); maxX = Math.max(maxX, poly[i]);
        minY = Math.min(minY, poly[i + 1]); maxY = Math.max(maxY, poly[i + 1]);
      }
      this._fillRegion(minX, minY, maxX, maxY, (px, py) => pointInPolygon(px, py, poly));
    }
  }

  clip() {
    // Renderer 仅用矩形 clip；其它形状直接抛错以防误用
    if (this._path.length !== 1 || this._path[0].length !== 8) {
      throw new Error('SoftCanvas: clip 仅支持单个矩形');
    }
    const p = this._path[0];
    const x = Math.min(p[0], p[2], p[4], p[6]);
    const y = Math.min(p[1], p[3], p[5], p[7]);
    const w = Math.max(p[0], p[2], p[4], p[6]) - x;
    const h = Math.max(p[1], p[3], p[5], p[7]) - y;
    const cur = this._clipBounds();
    const nx = Math.max(x, cur.x);
    const ny = Math.max(y, cur.y);
    const nr = Math.min(x + w, cur.x + cur.w);
    const nb = Math.min(y + h, cur.y + cur.h);
    this._clip = { x: nx, y: ny, w: Math.max(0, nr - nx), h: Math.max(0, nb - ny) };
  }

  fillRect(x, y, w, h) {
    this._fillRegion(x, y, x + w, y + h, (px, py) => px >= x && px < x + w && py >= y && py < y + h);
  }

  clearRect(x, y, w, h) {
    const clip = this._clipBounds();
    const sx = Math.max(Math.floor(x), Math.floor(clip.x), 0);
    const sy = Math.max(Math.floor(y), Math.floor(clip.y), 0);
    const ex = Math.min(Math.ceil(x + w), Math.ceil(clip.x + clip.w), this.canvas.width);
    const ey = Math.min(Math.ceil(y + h), Math.ceil(clip.y + clip.h), this.canvas.height);
    for (let py = sy; py < ey; py++) {
      for (let px = sx; px < ex; px++) {
        const idx = (py * this.canvas.width + px) * 4;
        this.buf[idx] = this.buf[idx + 1] = this.buf[idx + 2] = this.buf[idx + 3] = 0;
      }
    }
  }

  drawImage(source, dx, dy) {
    const clip = this._clipBounds();
    const sx = Math.max(Math.floor(dx), Math.floor(clip.x), 0);
    const sy = Math.max(Math.floor(dy), Math.floor(clip.y), 0);
    const ex = Math.min(Math.ceil(dx + source.width), Math.ceil(clip.x + clip.w), this.canvas.width);
    const ey = Math.min(Math.ceil(dy + source.height), Math.ceil(clip.y + clip.h), this.canvas.height);
    const srcCtx = source.getContext('2d');
    for (let py = sy; py < ey; py++) {
      for (let px = sx; px < ex; px++) {
        const si = ((py - dy) * source.width + (px - dx)) * 4;
        const a = srcCtx.buf[si + 3] / 255;
        if (a === 0) continue;
        this._blendPixel(px, py, srcCtx.buf[si], srcCtx.buf[si + 1], srcCtx.buf[si + 2], a);
      }
    }
  }

  getImageData(x, y, w, h) {
    const data = new Uint8ClampedArray(w * h * 4);
    for (let row = 0; row < h; row++) {
      const srcStart = ((y + row) * this.canvas.width + x) * 4;
      data.set(this.buf.subarray(srcStart, srcStart + w * 4), row * w * 4);
    }
    return { data, width: w, height: h };
  }
}

export class SoftCanvas {
  constructor(width, height) {
    this.width = width;
    this.height = height;
    this._ctx = new SoftContext2D(this);
  }
  getContext(kind) {
    if (kind !== '2d') throw new Error('SoftCanvas 仅支持 2d');
    return this._ctx;
  }
}

// 让 renderer.js 的 makeCanvas 在 Node 中命中 SoftCanvas
globalThis.OffscreenCanvas = SoftCanvas;
