# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目状态与设计基线

Mono-StickFigure 是框架无关的原生 TypeScript 网页火柴人工具包，核心没有运行时第三方依赖，不截图、不联网。当前是未发布的早期预览版，`package.json` 保持 `private: true`。

目前实现真实 DOM 的水平实线上边框、可区分纯色填充和文字顶部识别，支持平台锚点、滚动与平移跟随、目标驱动的自主走跑及有界导航。默认人物高度 16 CSS px、单色侧向骨架；支持 16 个可请求动作，包括跑跳、助跑远跳和翻滚，高冲击落地在空间足够时衔接翻滚。`anticipate / brake` 是内部过渡状态，不在可请求动作列表中。

当前可运行 API 和示例以 `README.zh.md`、`README.md`、`src/types.ts` 为准；`docs/` 还保留完整首版目标和拟定扩展契约：

- `docs/00-调研与技术决策.md`：技术选型与识别边界。
- `docs/01-需求分析.md`：完整首版需求，不代表全部已实现。
- `docs/02-详细设计.md`：架构不变量；第 11 节区分当前 API 与未实现的扩展。
- `docs/03-实施与验收计划.md`：分阶段验收；第 12 节保留首个闭环历史，第 13 节记录后续动作、识别与演示阶段。

简单 SVG 平台提取、open Shadow DOM 自动遍历、Provider 与动作/触发注册、运行时外观设置和 `/presets` 尚未实现；可以显式提供 `ShadowRoot` 作为扫描根。24 个动作、20 类触发和五个原始场景仍是完整首版目标，不能以当前子集代替。

## 开发与验证命令

使用 npm 和现有 `package-lock.json`。构建工具的 Node.js 范围为 `^22.18.0 || ^24.11.0 || >=26.0.0`；已有阶段验证使用 Node.js 24。以下命令可在 Windows Git Bash 中执行。

```sh
npm ci
npm run build
npm run dev
```

演示地址为 `http://127.0.0.1:5173/examples/`。Vite 固定该地址和端口，端口占用时直接失败。`examples/main.ts` 导入的是 `dist/index.mjs`，不是源码 alias；修改库源码时，在另一个终端运行 `npm run build:watch`，或手动重新构建。

| 命令 | 用途 |
| --- | --- |
| `npm run typecheck` | 严格类型检查，覆盖 `src`、`examples`、`tests` 和根目录配置 |
| `npm test` | 运行全部 Vitest 单元测试 |
| `npm test -- tests/unit/motion.test.ts` | 运行单个单元测试文件 |
| `npm test -- tests/unit/motion.test.ts -t "扫掠捕获"` | 按名称筛选单元测试 |
| `npm run test:browser` | 运行全部 Playwright 集成测试 |
| `npm run test:browser -- tests/browser/vertical-slice.spec.ts --grep "根位置不瞬移"` | 筛选单个浏览器测试文件及用例 |
| `npm run verify:demo` | 有界面 Edge 操作演示，保存截图、布局检查与初步计时 |
| `npm run bench` | 无界面 Edge 对比相同 Pose 的 Canvas / SVG 绘制调用耗时 |
| `mkdir -p .artifacts && npm run test:package` | 从 tarball 独立消费，检查类型、ESM/CJS、SSR 与发布文件白名单 |

没有 lint 脚本。

浏览器测试、演示验证、基准和打包检查都需要先运行 `npm run build`：

- Playwright 配置使用本机安装的 Microsoft Edge（`channel: 'msedge'`），不是自带 Chromium；以单 worker 执行，并自动启动或复用 Vite 服务。
- `verify:demo` 和 `bench` 不启动服务，需要提前在另一终端运行 `npm run dev`；两者也使用本机 Edge。`MONO_VERIFY_RUN` 可为演示验证指定独立证据目录后缀；报告包含动作序列、页面错误、导航/关闭/崩溃事件，重载消息不等于实际页面导航。
- `test:package` 必须通过 npm 脚本运行，因为它依赖 `npm_execpath`；脚本不会创建 `.artifacts/` 父目录，故命令中显式创建。检查会提取两份 README 和详细设计第 11.1–11.2 节的真实 TypeScript 代码块，在 tarball 独立消费目录严格编译，不编译拟定扩展契约。
- 验证脚本将本地证据写入 `.artifacts/`，该目录不进入 Git 或 npm 包。手机尺寸模拟不是真机验证，小型绘制基准也不是完整页面性能验收。

## 运行时架构

### 公共入口与包产物

`src/index.ts` 转发 `src/core.ts`；两个入口目前都创建同一个 `StickFigureController`，`/core` 并非独立的无 DOM 物理内核。`tsdown.config.ts` 将两个入口构建为 ESM `.mjs`、CJS `.cjs`、各自的 `.d.mts / .d.cts` 声明及 source maps，输出到 `dist/`；`package.json` 的条件 exports 必须与这些产物匹配。

导入和 `createStickFigure()` 不访问 DOM。只有 `start()` 初始化浏览器资源，Node / SSR 可以导入、创建和销毁实例，但不能启动。

### 帧管线与模块边界

`src/runtime/controller.ts` 编排每帧，按以下顺序工作：

```text
视口读取、当前支撑校验、参考系重投影
  → 预算化 DOM 扫描与邻域平台重测
  → 固定步长根运动、扫掠碰撞与接触
  → 同一参考系内的物理样本绘制插值
  → 骨架姿态采样、融合和两段腿 IK
  → 小型 Canvas 绘制、快照指标与事件派发
```

- `src/scene/store.ts` 持有 DOM 来源，通过可续跑 TreeWalker 分摊发现成本，并限制缓存数量。当前支撑和目标被 pinned，不能作为普通缓存淘汰；同帧测量只在相同 viewport 对象下共享，不跨帧复用几何。来源代次在实例内递增分配，失效缓存清理后重新发现不能复用旧代次；消费者比较身份，不依赖每个来源连续加一。没有新的 valid 测量时，border / fill 共存元素沿用既有平台类型，避免离屏时改变来源代次。`data-mono-stickfigure` 标记用于排除自身绘制节点。
- `src/perception/dom-surfaces.ts` 要求实际绘制证据，抽取 HTML 实线上边框及纯色 fill；fill 的保守 bounds 还参与侧撞和顶头。颜色判断重建有限局部绘制栈，包含 alpha 和祖先 opacity，以 OKLab 色差和 fill 自身贡献判断，默认阈值 0.01。关闭 `details` 的非 `summary` 后代明确失效，不能信任旧的非零布局矩形。圆角和 overflow 缩减可用区间，无法可靠处理的变换、裁剪和合成返回 `unknown`。
- `src/perception/text-surfaces.ts` 使用 Range 和 TextMetrics 估计普通字墨顶部，字号至少 48 px 的水平 ltr 文字通过本地字形重绘提取顶部轮廓近似；不截图、不改写 DOM，不读取表单当前值或 contenteditable。当前依赖 `Intl.Segmenter`，不能宣称全部字形、emoji 或复杂 shaping 都精确支持。
- `src/coordinates/frames.ts` 负责 client CSS 像素与 document / viewport / scroll 参考系转换。接触使用 `{ surfaceId, sourceRevision, u }` 锚点，每帧从平台重建位置；空中运动保存所选参考系中的局部位置。不能把人物固定在旧屏幕坐标，也不能重复叠加页面滚动量。
- `src/motion/solver.ts` 与 `src/animation/` 是不访问 DOM 的数值模块：前者推进根位置和扫掠碰撞，后者在根局部空间求姿态与 IK。物理根以脚部接触为基准，姿态和渲染不能自行推进世界位置或拉长骨段补偿不可达接触；走跑步态由相对平台路程驱动。
- `src/motion/navigation.ts` 执行有界 Dijkstra，`findRoute` 最多 64 个候选、`reachableRoutes` 最多 48 个。规划与起跳校验首次碰撞，助跑必须实际加速；没有独立导航时间预算，不是 A* 或全页完备搜索。Controller 的 `moveTo` 管理目标、重规划与 AbortSignal，取消空中请求不能冻结物理；手动普通跑跳或翻滚可保留并恢复兼容的移动目标。
- Controller 在当前参考系插值前后物理样本用于绘制，快照仍返回物理状态。接触切换、放置、暂停恢复和边界循环清旧样本；插值不能落到已失效平台或重复叠加滚动。
- `src/rendering/canvas.ts` 只绘制和移动人物大小的局部画布，保持 `pointer-events: none`、`aria-hidden` 和自身排除标记。挂载点不能处于不支持的变换或隔离包含块中。
- `src/runtime/scheduler.ts` 目前只有 `FixedStepClock`：120 Hz 物理步长、每帧最多六个子步并丢弃过量积压。每个 Controller 自有 clock 和 rAF，不存在共享场景调度器。

### 生命周期、失效与暂停

同一实例重复 `start()` 复用启动 Promise；`destroy()` 幂等并取消未完成请求，销毁后不可重启。

暂停原因保存在 Set 中，`resume()` 只能清除 `user` 原因。支撑 `invalid` 时释放接触并坠落；滚动导致 `offscreen` 时保留锚点、隐藏暂停；`unknown` 进入待验证暂停而不是被当作删除。临时性暂停保留 250 ms 低频复查途径，用户暂停或文档隐藏时停止主动复查，恢复后重测并重置时钟。默认尊重 `prefers-reduced-motion`。

`getSnapshot()` 返回值副本，平台列表仅在 `debug: true` 时提供，不能暴露内部可变状态或 DOM 引用。`diagnostics.frameMs` 是当前 tick 耗时减去 `scanMs`，不是 rAF 间隔或整页帧耗时；不能据此宣称真机帧率或完整性能达标。

## 测试与演示的关系

`tests/unit/` 在无浏览器环境验证数值运动、坐标、IK、时钟和生命周期；`tests/browser/` 使用真实 DOM 验证识别、滚动、支撑消失、交互透传及重复创建/销毁的资源释放。DOM 识别准确性不能由手工注入的矩形或模拟 DOM 布局证明。

演示通过 `window.mono` 和 `window.demoReady: Promise<void>` 提供浏览器入口，`?mode=manual` 停止自主决定。动作全部平铺，远跳、高落翻滚及 Element / document 坐标路线有专用入口，请从真实按钮等待结果反馈。测试应消费构建后的演示包，不能改成源码 alias 来绕过产物问题。`tests/fixtures/svg-reference.ts` 仅用于渲染对照，不是已发布的 SVG 渲染器。现有测试和第 12 节历史结果不能证明新增识别、动作与导航全部已覆盖；用户当前要求暂不新增测试，变更后以真实 example 操作验证。
