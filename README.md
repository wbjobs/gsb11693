# 渲染排序与脏矩形重绘对照

大量重叠对象场景下的渲染优化演示：z-order 排序、脏矩形局部重绘、图层缓存，
并与全量重绘做帧率对照。

## 技术栈

- **Canvas 2D**：主渲染目标 + 图层离屏缓存（OffscreenCanvas，自动降级普通 canvas）
- **Web Worker**（module worker）：对象运动模拟线程，TypedArray  transferable 回传位置
- **PerformanceObserver**：采集 longtask 与 `render-full` / `render-dirty` measure
- **IndexedDB**：持久化基准运行记录与帧样本，页面柱状图展示历史对照

## 运行

```bash
npm run serve          # http://localhost:8080（ES Module + Worker 需要 HTTP 环境）
```

页面操作：

- 切换「全量重绘 / 脏矩形重绘」实时对比 FPS
- 「运行基准对照」同负载下各跑 5s，输出加速比并写入 IndexedDB
- 每 120 帧自动做一次像素级一致性校验（也可手动触发）
- 可调对象数量、缓存预算、降级阈值；可关闭图层缓存做对照

## 测试

```bash
npm test               # Node 内置 test runner
```

- `test/logic.test.mjs`：纯逻辑单测（z 排序稳定性、矩形合并/降级、场景模拟不越界）
- `test/render.e2e.test.mjs`：通过软件光栅化 Canvas（`test/softcanvas.mjs`）在 Node 中
  运行**真实 Renderer**，覆盖全部验收标准
- `test/e2e.html`：浏览器内验收页（`http://localhost:8080/test/e2e.html`）

## 验收标准覆盖

| 标准 | 实现 | 验证 |
| --- | --- | --- |
| z-order 排序正确 | `src/zsort.js` 稳定排序（z 升序，同 z 按 seq） | 验收1 |
| 脏矩形与全量一致 | `src/renderer.js` renderDirty，脏矩形对齐整数像素并外扩 1px 消除 clip 抗锯齿差异 | 验收2/2b（40 帧逐像素 0 差异） |
| 帧率对照可量化 | FPSMeter + performance.measure + IndexedDB 历史 | 验收3（实测加速比约 38x，软光栅环境） |
| 脏矩形合并正确 | `src/rects.js` 相交合并 + 贪心最小代价合并 + maxRects 上限 | 验收4（覆盖完整性断言） |
| 图层缓存正确 | `LayerCache` 按层位图缓存，事件驱动失效（move/zchange/recolor/layerchange） | 验收5（命中/失效计数） |
| 内存可控 | 字节预算 + LRU 驱逐；HUD 显示缓存用量与 JS 堆 | 验收6（预算约束 + 驱逐断言） |
| 降级到全量重绘 | 合并后覆盖面积超阈值（默认 60%）自动回退全量 | 验收7 |

## 架构

```
index.html            演示页面（控制面板 + HUD + 历史图表）
src/
  rects.js            矩形运算与脏矩形合并（纯逻辑）
  zsort.js            z-order 稳定排序（纯逻辑）
  scene.js            场景生成与模拟步进（主线程/Worker 共用）
  renderer.js         Renderer（全量/脏矩形）+ LayerCache（LRU + 字节预算）
  metrics.js          FPSMeter + PerformanceObserver 封装
  db.js               IndexedDB 封装（runs / samples）
  worker.js           模拟 Worker（120Hz 步进， transferable 回传）
  main.js             渲染循环、基准对照、一致性校验、HUD
```

关键设计：

- **脏矩形来源**：每个移动对象的「旧包围盒 ∪ 新包围盒」，加上 z/图层/颜色变化对象的包围盒
- **合并策略**：先合并相交矩形，再按最小合并代价贪心合并（slack 内允许少量过绘制），
  强制满足数量上限；总覆盖面积超阈值则降级全量
- **缓存失效**：对象移动/变色/z 变化 → 失效所在层；跨层迁移 → 全部失效（保守策略）
- **内存控制**：缓存预算可配，超预算按 LRU 驱逐整层位图
