# Mono-StickFigure

简体中文 | [English](README.md)

让一个小小的火柴人，把你的网页变成游乐场。

框架无关的原生 TypeScript 工具包，没有运行时第三方依赖。人物寻找真实 DOM 的绘制平台，沿可达路线走跑、跳跃，跟随滚动和平台移动；支撑消失后自然下落。局部小型 Canvas 不阻挡点击、文字选择或页面滚动。

## 本地体验

使用 Node.js `^22.18.0 || ^24.11.0 || >=26.0.0` 和 npm：

```sh
npm ci
npm run build
npm run dev
```

打开[实验场](http://127.0.0.1:5173/examples/)，或用[手动模式](http://127.0.0.1:5173/examples/?mode=manual)观察动作，避免自主决策接着移动。

演示导入 `dist/index.mjs`。修改库源码后需要重新构建，或另开终端运行 `npm run build:watch`。开发服务使用固定端口，5173 被占用时不会自动换端口。

版本只在 [package.json](package.json) 中维护；包的 `VERSION` 导出和示例显示从该字段引用。可在仓库根目录运行 `npm pack --json`，按输出的 `filename` 安装本地产物。公开 registry 中实际已发布的版本请通过 `npm view mono-stickfigure version` 查询，再使用 `npm install mono-stickfigure` 安装；本地版本号不等于已发布。

## 当前能力

- 识别可见实线水平边框（上边优先，底边可作为备用落脚线）、有色差的纯色填充块，包括无边框按钮。
- 人物周围通过有限命中采样和可续扫队列优先发现尚未全局扫描的文字/元素；长段落优先测量命中位置附近的分词。邻域发现、全局扫描与平台刷新共享原扫描预算，缓存满时优先保留附近平台；不做每帧全页重扫描，也不依赖具体网站类名。
- 普通文字采用字墨顶部度量近似；大号水平、从左到右的文字采用局部字形顶部轮廓近似。
- 默认 16 CSS px 的单色侧向人物。
- 行走、跑步、冲刺、转身、招呼、蹲下、叉腰休息、趴下、起身，以及双手后撑的坐姿、单手揉头的疑问和原地高抬腿跑。
- 重力驱动的跳跃、跑跳、助跑远跳、坠落、落地缓冲；高落地且空间足够时立即进入肩背翻滚，展腿重新站稳。
- 沿真实竖直边及大于 80° 的长陡斜边攀爬；空中先伸双手，抓稳后短暂停顿并依次贴脚，再以三点支撑方式缓慢攀爬，最后可跳回平台。
- 元素、已识别平台、页面坐标目标；支持取消请求与有界路线规划。
- 平台相对锚点、滚动与受支持的平移跟随、动态失效、暂停恢复及资源释放。

核心不截取页面、不联网识别、不上传页面内容。大字识别只在本地重绘字形，并非页面截图；演示页本身会加载网络字体。

## 基本用法

在页面和目标元素挂载后启动。`#runway` 需要具有实际可见、足够宽的边框、填充或文字落脚点。

```ts
import { createStickFigure, VERSION } from 'mono-stickfigure';

console.log(VERSION);

const figure = createStickFigure({
  autonomous: false,
  appearance: { height: 16, color: '#181818', lineWidth: 1.2 },
  recognition: { colorTolerance: 0.01 },
});

await document.fonts.ready;
const started = await figure.start();
const runway = document.querySelector<HTMLElement>('#runway');

if (started.status !== 'paused' && runway) {
  const placed = await figure.place(runway);
  if (placed.status === 'placed') {
    const result = await figure.requestAction('run-jump', { direction: 1 });
    console.log(result);
  }
}
```

`place()` 在测量后显式重新定位人物，本身是瞬时放置。需要实际走过去时使用 `moveTo()`，不能连续调用 `place()` 代替运动。

## 目标与取消

```ts
const destination = document.querySelector<HTMLElement>('#destination');
const controller = new AbortController();

if (destination) {
  const moving = figure.moveTo(destination, {
    pace: 'run',
    signal: controller.signal,
  });
  const cancelButton = document.querySelector<HTMLButtonElement>('#cancel');
  const cancel = () => controller.abort();
  cancelButton?.addEventListener('click', cancel, { once: true });
  const result = await moving;
  cancelButton?.removeEventListener('click', cancel);
  console.log(result);
}
```

已发现的平台可以使用 `{ surfaceId, u }`，其中 `u` 是沿顶部线段的归一化位置。Surface ID 属于当前实例，不是可持久化的 DOM 元素 ID。

页面坐标示例：

```ts
const result = await figure.moveTo(
  { position: { x: 640, y: 900 }, coordinateSpace: 'document' },
  { pace: 'walk' },
);
```

坐标目标只在已知有效平台中选择邻近可站点，不会生成地面。省略 `coordinateSpace` 时使用客户区/视口 CSS 像素。`pace` 控制平台上的行进速度，跨越间隔时仍可能需要更快的助跑。

取消返回 `interrupted / aborted`，不会冻结或瞬移空中的人物，物理仍继续到接触。地面移动先制动，翻滚从当前姿态恢复。`autonomous: false` 只关闭自主决策，不取消跑跳等动作的续跑阶段；需要收敛到静止时，在落地后请求 `idle`。

## 公共 API

| 方法 | 行为 |
| --- | --- |
| `start()` | 返回 `ready / empty / paused` 及 `supportedActions`；重复调用复用启动 Promise。 |
| `place(target)` | 返回 `placed / rejected`；目标有效时取消已有动作和移动请求。用户暂停时也可放置，但不会自动恢复。 |
| `moveTo(target, { pace, signal }?)` | 规划真实运动；`pace` 为 `walk / run / sprint`。 |
| `requestAction(id, { target, direction, duration, signal }?)` | 请求支持的动作；方向为 `1`（右）或 `-1`（左）。 |
| `setAutonomous(enabled)` | 开关自主决策，不停止空中物理。 |
| `pause()` / `resume()` | 增加/清除用户暂停原因，其他暂停原因独立保留。 |
| `on(event, listener)` | 返回取消订阅函数。 |
| `getSnapshot()` | 返回状态值副本；只有 `debug: true` 才提供 `surfaces`。 |
| `destroy()` | 幂等释放资源并中断请求；重新启动需要创建新实例。 |

动作/移动结果为 `{ status: 'completed' | 'rejected' | 'interrupted', reason?: string }`。Promise 正常返回不代表动作成功，需检查 `status`。常见原因包括 `unreachable`、`target-invalid`、`support-invalid`、`insufficient-space`、`obstructed`、`edge`、`boundary`、`replaced` 和 `aborted`。非法创建配置会抛错；缺少浏览器或挂载条件不满足时 `start()` 会拒绝。

当前 20 个可请求动作：

```text
idle, walk, run, sprint, turn,
wave, crouch, rest, prone, stand-up,
jump, run-jump, running-long-jump, fall, land-soft, roll,
sit, question, run-in-place, climb
```

`anticipate` 和 `brake` 是可在快照/事件中观察的内部过渡状态，不能直接请求。反向跳先制动并转身。带目标的跳跃是一次跳跃请求，必要时包含助跑；多步路线使用 `moveTo()`。

`duration` 单位为秒，只控制有时长的移动/姿态阶段，不是整个 Promise 的总耗时。范围为 0.1–10，翻滚为 0.65–10。跳跃和坠落由物理决定结束；过渡和落地恢复会增加时间，跑跳/远跳完成后可能继续原来的移动。

事件为 `ready`、`statechange`、`actionchange`、`surfacechange`、`targetchange`、`navigationchange`、`boundary` 和 `error`：

```ts
const unsubscribe = figure.on('actionchange', ({ action }) => {
  console.log(action);
});

figure.setAutonomous(true);
figure.pause();
figure.resume();
unsubscribe();
figure.destroy();
```

## 重力、攀爬与自主目标

`physics.gravity` 以实际加速度 m/s² 设置，默认 `9.8`，允许任意有限值 `4–20`，不是等级或倍率字段，也不会量化或静默钳位。内部采用固定 `100 CSS px/m` 换算，绘制大小不会改变重力；`jumpHeight` 仍用 CSS px。`maxFallSpeed` 为有限正数，单位 CSS px/s，默认 `600`，不随人物大小改变。

```ts
const tunedFigure = createStickFigure({
  physics: { gravity: 12.255, jumpHeight: 52, maxFallSpeed: 600 },
  performance: { navigationBudgetMs: 1, scanBudgetMs: 2 },
});
tunedFigure.destroy();
```

下面公式中的 `g` 为内部换算后的 CSS px/s²。空中无水平外力时 `x = x0 + vx × t`，竖直方向 `y = y0 + vy0 × t + ½g × t²`；水平匀速与竖直加速共同形成抛物线，并非整段匀速运动。极长下降达到 `maxFallSpeed` 后按限速分段积分，规划与运行使用同一模型，不能再把此后的轨迹称为无限抛物线。

`requestAction('climb', { target, signal })` 可以指定真实陡边元素或 `{ surfaceId, u }`，抓到目标边后会沿该边完成攀爬，不为抄近路再跳回平台。抓附后先由入抓速度、重力和阻尼驱动下身摆向墙，在约 0.9 秒的附件阶段屈膝收腿并依次贴脚尖，贴稳后才沿边运动；沿墙速度上限为每秒 0.4 倍人物高度；`pace` 不会把攀爬加速成跑步。省略目标时只尝试附近有效边段。`moveTo()` 也能组合抓边、攀爬和离边跳跃；`place()` 仍仅显式放到水平支撑。快照的 `climb` 与 `support` 分开：攀爬停止或取消时保留有效抓持，平台消失或边段失效则释放并下落；空中取消不冻结速度。

自动漫游先在已识别、可见且可承载的真实区间选择随机目的地，再逐帧规划路线；到达后立即选新目的地，可短暂休息或徘徊后再出发。途中低概率改目标，空中不会为追新目标瞬间改速。不可达时允许局部探索、限频重规划和重新选点，而不制造地面或每帧全页求路。

快照的 `navigation` 提供目标编号、当前直线距离、规划状态/原因、累计规划耗时、候选/展开/边检查数量和重规划次数。只有 `debug: true` 才返回定长 `history`；`navigationchange` 只在决策变化时发布，不每帧推送，也不记录 DOM 引用或页面内容。示例每 250 ms 显示这些信息。

其他创建默认值：重力 `9.8` m/s²、跳高 `52` CSS px、扫描预算 `2` ms、导航预算 `1` ms、平台缓存上限 `1500`、DPR 上限 `2`、开启自主决策、尊重系统减少动态效果偏好。当前没有运行时外观/物理/识别设置方法，修改这些配置需销毁后重新创建。

## 能力边界

- 色差采用局部重建的合成色和 OKLab，默认 `colorTolerance: 0.01`。前后景同色不构成平台证据；无法可靠合成的复杂绘制可能保持未知。
- 水平边框和文字是单向顶部支撑；填充块还提供保守实体边界，参与侧撞和顶头。翻滚仍使用完整人物高度检查碰撞空间。
- 文字近似不是精确页面像素。图片内部、任意 SVG path、滤镜、mask 和复杂裁剪不自动识别。
- 陡边限于真实 HTML solid 边框、可区分纯色 fill 侧边，以及能可靠恢复几何的自身简单二维旋转实线边。角度严格大于 80°，连续可用长度至少为人物高度的两倍；复杂祖先变换、3D/perspective、mask/clip-path 等未知绘制不强行识别。旋转后的外接矩形不能当作真实斜坡或实体。
- 攀爬出口必须有可达的真实平台；当前通过已校验的跳跃登台或跳回外侧平台，不提供无外沿纯墙的拉上/翻越动作。
- 导航是已知候选上的有界 Dijkstra，不是 A*，也不是全页完备搜索。`navigationBudgetMs` 控制可续跑搜索的每帧软预算；一次不可抢占工作可能超出设置值，预算耗尽只表示待续跑，不表示不可达。目标可以不可达；起跳后移动的平台不保证落中。
- 滚动导致支撑离屏时保留锚点、隐藏暂停；未知支撑等待验证，明确移除或不可见时释放接触。
- 默认边界循环会在空中人物从两侧或下方离开视口时中断当前请求；向上跳不会传送到底部。关闭循环则在画外等待，不生成虚构地板。
- 导入和创建实例支持 SSR；只有 `start()` 需要浏览器。当前 `/core` 与默认入口创建同一个 Controller。
- Provider/动作/触发注册、自动 Shadow DOM 遍历、SVG 平台提取和 `/presets` 尚未实现；可以显式指定 `ShadowRoot` 为扫描根。24 动作、20 类触发与完整五场景验收仍是首版目标。

## 开发与文档

```sh
npm run typecheck
npm test -- tests/unit/motion.test.ts
npm run test:browser
```

类型检查覆盖库、演示、测试和根目录配置。浏览器检查需要先构建，并使用本机安装的 Microsoft Edge；已有测试并不代表每项新增预览行为都有自动化覆盖。

详见[当前 API 与设计边界](docs/02-详细设计.md#11-公共-api-与扩展契约)、[实施与验证记录](docs/03-实施与验收计划.md)和[开发架构](CLAUDE.md)。设计文档区分可用接口与拟定扩展契约；手机尺寸模拟和小型绘制采样不是真机或完整性能验收。

## 许可证

[MIT](LICENSE) © 2026 MonoKelvin
