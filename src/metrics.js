// 性能指标：FPS 统计 + PerformanceObserver（longtask / measure）。

export class FPSMeter {
  constructor(windowSize = 120) {
    this.windowSize = windowSize;
    this.frameTimes = [];
    this.last = 0;
  }

  tick(now) {
    if (this.last > 0) {
      this.frameTimes.push(now - this.last);
      if (this.frameTimes.length > this.windowSize) this.frameTimes.shift();
    }
    this.last = now;
  }

  reset() {
    this.frameTimes.length = 0;
    this.last = 0;
  }

  get fps() {
    if (this.frameTimes.length === 0) return 0;
    const avg = this.frameTimes.reduce((a, b) => a + b, 0) / this.frameTimes.length;
    return avg > 0 ? 1000 / avg : 0;
  }

  get avgFrameMs() {
    if (this.frameTimes.length === 0) return 0;
    return this.frameTimes.reduce((a, b) => a + b, 0) / this.frameTimes.length;
  }

  get p95FrameMs() {
    if (this.frameTimes.length === 0) return 0;
    const sorted = [...this.frameTimes].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))];
  }
}

export class PerfMonitor {
  constructor() {
    this.longTasks = [];
    this.renderMeasures = [];
    this.observer = null;
  }

  start() {
    if (typeof PerformanceObserver === 'undefined') return;
    const types = [];
    if (PerformanceObserver.supportedEntryTypes?.includes('longtask')) types.push('longtask');
    if (PerformanceObserver.supportedEntryTypes?.includes('measure')) types.push('measure');
    if (types.length === 0) return;
    this.observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (entry.entryType === 'longtask') {
          this.longTasks.push({ start: entry.startTime, duration: entry.duration });
        } else if (entry.entryType === 'measure' && entry.name.startsWith('render-')) {
          this.renderMeasures.push({ name: entry.name, duration: entry.duration });
          if (this.renderMeasures.length > 600) this.renderMeasures.shift();
        }
      }
    });
    this.observer.observe({ entryTypes: types });
  }

  stop() {
    this.observer?.disconnect();
    this.observer = null;
  }

  measureRender(mode, fn) {
    const startMark = `render-${mode}-start`;
    const endMark = `render-${mode}-end`;
    performance.mark(startMark);
    const result = fn();
    performance.mark(endMark);
    performance.measure(`render-${mode}`, startMark, endMark);
    performance.clearMarks(startMark);
    performance.clearMarks(endMark);
    return result;
  }

  avgRenderMs(mode) {
    const name = `render-${mode}`;
    const list = this.renderMeasures.filter((m) => m.name === name);
    if (list.length === 0) return 0;
    return list.reduce((s, m) => s + m.duration, 0) / list.length;
  }
}
