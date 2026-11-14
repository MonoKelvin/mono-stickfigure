import { createStickFigure } from '../dist/index.mjs';
import type { StickFigure, ActionId, ActionResult } from '../dist/index.mjs';

const element = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const panel = element<HTMLDivElement>('panel');
const landing = element<HTMLButtonElement>('landing');
const state = element('state');
const message = element('message');
const size = element<HTMLInputElement>('size');
const gravity = element<HTMLInputElement>('gravity');
const tolerance = element<HTMLInputElement>('color-tolerance');
const cancelButtons = [element<HTMLButtonElement>('cancel-action'), element<HTMLButtonElement>('cancel-route')];
const actionButtons = [...document.querySelectorAll<HTMLButtonElement>('.action-button')];
let actor: StickFigure;
let autonomous = new URL(location.href).searchParams.get('mode') !== 'manual';
let request: AbortController | null = null;
let sequence: string[] = [];
let clicks = 0;

const labels: Record<string, string> = {
  created: '未启动', starting: '正在识别', running: '运行中', paused: '已暂停', destroyed: '已销毁',
  idle: '站立', walk: '行走', run: '跑步', sprint: '冲刺', turn: '转身', anticipate: '起跳预备', brake: '制动',
  wave: '招呼', crouch: '蹲下', rest: '叉腰休息', prone: '趴下', 'stand-up': '起身', jump: '跳跃',
  'run-jump': '跑跳', 'running-long-jump': '助跑远跳', fall: '坠落', 'land-soft': '落地缓冲', roll: '翻滚',
};
const reasons: Record<string, string> = {
  'not-running': '人物尚未运行；可以先恢复或重新开始', 'not-started': '请先重新开始',
  'no-support': '人物正在空中，请等它落地', 'no-visible-support': '这里没有可见且足够宽的落脚点',
  'support-invalid': '脚下的落脚点已改变', 'target-invalid': '目标落脚点已改变',
  'insufficient-space': '当前平台没有足够的动作空间', unreachable: '当前可见平台没有可达路线',
  'path-changed': '助跑或空中路线已改变', obstructed: '前方有色块边界阻挡',
  'reduced-motion': '系统开启了减少动态效果', destroyed: '实例已销毁', boundary: '人物已离开当前视口',
  replaced: '已被新的请求替换', placed: '已选择新的落脚点', 'action-requested': '已切换为指定动作',
  'move-requested': '已切换为目标移动', 'autonomy-disabled': '已停止自由决定', edge: '已到平台边缘',
};

function tell(text: string): void {
  message.textContent = text;
  element('route-message').textContent = text;
}

function showAction(result: ActionResult, name: string): void {
  if (result.reason === 'aborted') {
    tell(`${name}已取消。空中运动仍会自然落地，翻滚会先起身。`);
  } else if (result.status === 'completed') {
    tell(`${name}已完成${result.reason ? `：${reasons[result.reason] ?? result.reason}` : '。'}`);
  } else {
    tell(`${name}${result.status === 'rejected' ? '未执行' : '已中断'}：${reasons[result.reason ?? ''] ?? result.reason ?? '状态已改变'}。`);
  }
}

function showSequence(action: ActionId): void {
  const label = labels[action] ?? action;
  if (!request && autonomous) sequence = [label];
  else if (sequence.at(-1) !== label) sequence = [...sequence.slice(-7), label];
  const text = sequence.join(' → ');
  element('motion-sequence').textContent = text;
  element('route-sequence').textContent = text;
  for (const button of actionButtons) button.toggleAttribute('data-active', button.id === (action === 'fall' ? 'drop' : action));
}

function showMode(): void {
  const button = element('autonomy');
  button.textContent = autonomous ? '自由漫游' : '手动观察';
  button.setAttribute('aria-pressed', String(autonomous));
}

function cancelRequest(): void {
  request?.abort();
  for (const button of cancelButtons) button.disabled = true;
}

async function create(): Promise<void> {
  cancelRequest();
  request = null;
  actor?.destroy();
  sequence = [];
  showSequence('idle');
  panel.hidden = false;
  panel.classList.remove('moving');
  element('tree-branch').setAttribute('open', '');
  element('collapse-tree').textContent = '折叠子目录';
  element('collapse-tree').setAttribute('aria-pressed', 'false');
  element('move').textContent = '移动便笺';
  element('move').setAttribute('aria-pressed', 'false');
  element('hide-panel').textContent = '隐藏便笺';
  element('hide-panel').setAttribute('aria-pressed', 'false');
  element('pause').textContent = '暂停人物';
  const current = createStickFigure({
    root: document, seed: 7, debug: true, autonomous,
    appearance: { height: Number(size.value), color: '#181818', lineWidth: 1.2 },
    physics: { gravity: Number(gravity.value), jumpHeight: 52 },
    recognition: { colorTolerance: Number(tolerance.value) },
  });
  actor = current;
  window.mono = current;
  showMode();
  current.on('statechange', (value) => {
    if (actor !== current) return;
    state.textContent = labels[value] ?? value;
    if (value === 'destroyed') for (const button of cancelButtons) button.disabled = true;
  });
  current.on('actionchange', ({ action }) => {
    if (actor !== current) return;
    if (current.getSnapshot().status === 'running') state.textContent = labels[action] ?? action;
    showSequence(action);
  });
  current.on('error', (error) => { if (actor === current) tell(`${error.code}：${error.message}`); });
  try {
    await document.fonts.ready;
    if (actor !== current) return;
    await current.start();
    if (actor !== current) return;
    const result = await current.place(element('hero-title'));
    if (actor !== current) return;
    tell(result.status === 'placed'
      ? autonomous ? '从字里行间出发，慢慢探索整张页面。' : '手动观察中。选一个落脚点，或者试试走路和跳跃。'
      : '大字上暂时没有足够宽的落脚点，可以选择下方的文字或色块。');
  } catch (error) {
    if (actor === current) throw error;
  }
}

function run(task: Promise<unknown>): void {
  void task.catch((error: unknown) => { tell(error instanceof Error ? error.message : String(error)); });
}

async function perform(name: string, task: (current: StickFigure, signal: AbortSignal) => Promise<ActionResult>): Promise<void> {
  cancelRequest();
  const controller = new AbortController();
  const current = actor;
  request = controller;
  sequence = [];
  showSequence(current.getSnapshot().action);
  for (const button of cancelButtons) button.disabled = false;
  tell(`${name}，正在出发。`);
  try {
    const result = await task(current, controller.signal);
    if (actor === current && request === controller) showAction(result, name);
  } catch (error) {
    if (actor === current && request === controller) tell(error instanceof Error ? error.message : String(error));
  } finally {
    if (request === controller) {
      request = null;
      for (const button of cancelButtons) button.disabled = true;
    }
  }
}

const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

async function prepare(current: StickFigure, signal: AbortSignal, source: string, platforms: string[] = []): Promise<ActionResult | null> {
  if (signal.aborted || actor !== current) return { status: 'interrupted', reason: 'aborted' };
  autonomous = false;
  current.setAutonomous(false);
  showMode();
  element('route-terrain').scrollIntoView({ block: 'center', behavior: 'instant' });
  await frame();
  await frame();
  if (signal.aborted || actor !== current) return { status: 'interrupted', reason: 'aborted' };
  current.pause();
  let failure: ActionResult | null = null;
  for (const id of [...platforms, source]) {
    const result = await current.place(element(id));
    if (result.status !== 'placed') { failure = { status: 'rejected', reason: result.reason }; break; }
  }
  current.resume();
  element('pause').textContent = '暂停人物';
  await frame();
  if (signal.aborted || actor !== current) return { status: 'interrupted', reason: 'aborted' };
  return failure;
}

function action(id: ActionId): void {
  run(perform(labels[id] ?? id, async (current, signal) => {
    await frame();
    await frame();
    if (signal.aborted || actor !== current) return { status: 'interrupted', reason: 'aborted' };
    const snapshot = current.getSnapshot();
    if (snapshot.position && !snapshot.pauses.includes('user')) {
      const y = snapshot.position.y;
      if (y < snapshot.appearance.height + 80 || y > innerHeight - 80) {
        scrollBy({ top: y - innerHeight * 0.55, behavior: 'instant' });
        await frame();
        await frame();
      }
    }
    if (signal.aborted || actor !== current) return { status: 'interrupted', reason: 'aborted' };
    return current.requestAction(id, { signal });
  }));
}

async function place(id: string): Promise<void> {
  cancelRequest();
  request = null;
  const current = actor;
  const target = element(id);
  target.scrollIntoView({ block: 'center', behavior: 'instant' });
  await frame();
  await frame();
  if (actor !== current) return;
  const result = await current.place(target);
  if (actor !== current) return;
  if (result.status !== 'placed') {
    tell('这里没有足够清楚的文字、填充交界或边框，不能站立。');
    return;
  }
  const snapshot = current.getSnapshot();
  const surface = snapshot.surfaces.find((candidate) => candidate.id === snapshot.support?.surfaceId);
  const names = { border: '实线边框', fill: '填充色块的交界', text: surface?.evidence === 'text-contour' ? '大字的字形顶部' : '文字顶部' };
  tell(`已站到${surface ? names[surface.kind] : '落脚点'}上。`);
}

for (const id of ['idle', 'walk', 'run', 'sprint', 'jump', 'run-jump', 'wave', 'crouch', 'rest', 'prone', 'stand-up', 'turn', 'running-long-jump', 'land-soft', 'roll'] as const) element(id).onclick = () => action(id);
element('drop').onclick = () => action('fall');
for (const button of cancelButtons) button.onclick = cancelRequest;
element('demo-long-jump').onclick = () => run(perform('助跑远跳', async (current, signal) => {
  const failure = await prepare(current, signal, 'motion-runway');
  if (failure) return failure;
  const support = current.getSnapshot().support!;
  await current.place({ surfaceId: support.surfaceId, u: 0.18 });
  return current.requestAction('running-long-jump', { direction: 1, signal });
}));
element('demo-drop').onclick = () => run(perform('高落地与翻滚', async (current, signal) => {
  const failure = await prepare(current, signal, 'drop-source', ['route-source']);
  return failure ?? current.requestAction('fall', { signal });
}));
for (const id of ['demo-route', 'demo-point']) element(id).onclick = () => run(perform(id === 'demo-point' ? '页面坐标导航' : '目标导航', async (current, signal) => {
  const failure = await prepare(current, signal, 'route-source', ['route-step', 'route-goal']);
  if (failure) return failure;
  const pace = element<HTMLSelectElement>('route-pace').value as 'walk' | 'run' | 'sprint';
  const target = element('route-goal');
  if (id === 'demo-route') return current.moveTo(target, { pace, signal });
  const box = target.getBoundingClientRect();
  return current.moveTo({ position: { x: box.left + box.width / 2 + scrollX, y: box.top + scrollY }, coordinateSpace: 'document' }, { pace, signal });
}));
element('restart').onclick = () => { window.demoReady = create(); run(window.demoReady); };
element('autonomy').onclick = () => {
  autonomous = !autonomous;
  actor.setAutonomous(autonomous);
  showMode();
  tell(autonomous ? '自由漫游开启，它会选择目标，再寻找可达路线。' : '自由决定已停止；正在进行的跳跃或坠落仍会正常完成。');
};
size.oninput = () => { element('size-value').textContent = `${size.value} px`; };
gravity.oninput = () => { element('gravity-value').textContent = `${gravity.value} px/s²`; };
tolerance.oninput = () => { element('tolerance-value').textContent = Number(tolerance.value).toFixed(2); };
for (const setting of [size, gravity, tolerance]) setting.onchange = () => {
  window.demoReady = create();
  run(window.demoReady);
};
element('place-panel').onclick = () => run(place('panel'));
element('place-button').onclick = () => run(place('landing'));
element('navigate-button').onclick = () => run(perform('目标导航', (current, signal) => current.moveTo(landing, { pace: 'run', signal })));
element('move').onclick = () => {
  const moving = panel.classList.toggle('moving');
  element('move').textContent = moving ? '停止移动' : '移动便笺';
  element('move').setAttribute('aria-pressed', String(moving));
};
element('hide-panel').onclick = () => {
  panel.hidden = !panel.hidden;
  element('hide-panel').textContent = panel.hidden ? '恢复便笺' : '隐藏便笺';
  element('hide-panel').setAttribute('aria-pressed', String(panel.hidden));
  tell(panel.hidden ? '支撑消失，立即释放接触并由重力接管。' : '便笺已恢复，可以重新定位人物。');
};
element('pause').onclick = () => {
  if (actor.getSnapshot().pauses.includes('user')) { actor.resume(); element('pause').textContent = '暂停人物'; }
  else { actor.pause(); element('pause').textContent = '恢复人物'; }
};
element('destroy').onclick = () => { cancelRequest(); request = null; actor.destroy(); tell('实例已销毁；画布、观察器和帧任务一并释放。'); };
landing.onclick = () => { element('clicks').textContent = String(++clicks); };
element('collapse-tree').onclick = () => {
  const branch = element<HTMLDetailsElement>('tree-branch');
  branch.open = !branch.open;
  element('collapse-tree').textContent = branch.open ? '折叠子目录' : '展开子目录';
  element('collapse-tree').setAttribute('aria-pressed', String(!branch.open));
};
element('contrast-toggle').onclick = () => {
  const low = element('color-probe').classList.toggle('is-low');
  element('contrast-toggle').textContent = low ? '提高对比度' : '降低对比度';
  element('contrast-toggle').setAttribute('aria-pressed', String(low));
};
element('test-transparent').onclick = () => run(place('transparent-box'));
const placeClick = (event: MouseEvent) => {
  const button = (event.target as Element).closest<HTMLButtonElement>('button[data-place]');
  if (button?.dataset.place) run(place(button.dataset.place));
};
document.addEventListener('click', placeClick);
element<HTMLFormElement>('sample-form').onsubmit = (event) => {
  event.preventDefault();
  const name = element<HTMLInputElement>('field-platform').value.trim() || '这个小居民';
  const topic = element<HTMLSelectElement>('topic').value;
  element('form-result').textContent = `记下了：${name}，今天想逛${topic}。页面交互照常工作。`;
};

const diagnostics = window.setInterval(() => {
  if (!actor) return;
  const snapshot = actor.getSnapshot();
  const p = snapshot.position;
  const target = snapshot.target?.position;
  element('diagnostics').textContent = [
    `动作  ${labels[snapshot.action]} / 朝${snapshot.facing === 1 ? '右' : '左'}`,
    `自由活动  ${snapshot.autonomous ? '开' : '关'}`,
    `大小  ${snapshot.appearance.height} px`,
    `重力  ${snapshot.physics.gravity} px/s² / 跳高 ${snapshot.physics.jumpHeight} px`,
    `根位置  ${p ? `${p.x.toFixed(1)}, ${p.y.toFixed(1)}` : '未创建'}`,
    `速度  ${snapshot.velocity.x.toFixed(1)}, ${snapshot.velocity.y.toFixed(1)} px/s`,
    `支撑  ${snapshot.support?.surfaceId ?? '空中'}`,
    `目标  ${target ? `${target.x.toFixed(1)}, ${target.y.toFixed(1)}` : '未选择'} / 路径 ${snapshot.path.length} 步`,
    `色差阈值  ${snapshot.recognition.colorTolerance.toFixed(2)}`,
    `平台数量  ${snapshot.diagnostics.surfaceCount}`,
    `当前帧  ${snapshot.diagnostics.frameMs.toFixed(2)} ms`,
    `扫描  ${snapshot.diagnostics.scanMs.toFixed(2)} ms`,
    `暂停原因  ${snapshot.pauses.join(', ') || '无'}`,
  ].join('\n');
}, 250);
window.addEventListener('pagehide', () => {
  clearInterval(diagnostics);
  document.removeEventListener('click', placeClick);
  request?.abort();
  actor?.destroy();
}, { once: true });

window.demoReady = create();
run(window.demoReady);

declare global {
  interface Window {
    mono: StickFigure;
    demoReady: Promise<void>;
  }
}
