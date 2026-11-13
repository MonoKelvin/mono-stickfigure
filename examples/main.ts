import { createStickFigure } from '../dist/index.mjs';
import type { StickFigure, ActionResult } from '../dist/index.mjs';

const element = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const panel = element<HTMLDivElement>('panel');
const landing = element<HTMLButtonElement>('landing');
const state = element<HTMLSpanElement>('state');
const message = element<HTMLParagraphElement>('message');
let actor: StickFigure;
let clicks = 0;

const labels: Record<string, string> = {
  created: '未启动', starting: '正在识别', running: '运行中', paused: '已暂停', destroyed: '已销毁',
  idle: '站立', jump: '上升', fall: '坠落', 'land-soft': '落地',
};

function showAction(result: ActionResult): void {
  message.textContent = result.status === 'completed' ? '动作完成，接触仍然稳定。' : `动作${result.status === 'rejected' ? '未执行' : '已中断'}：${result.reason ?? '状态已改变'}`;
}

async function create(): Promise<void> {
  actor?.destroy();
  panel.hidden = false;
  panel.classList.remove('moving');
  element('move').textContent = '移动面板';
  element('move').setAttribute('aria-pressed', 'false');
  element('hide-panel').textContent = '隐藏面板';
  element('hide-panel').setAttribute('aria-pressed', 'false');
  element('pause').textContent = '暂停人物';
  actor = createStickFigure({ root: element('playground'), seed: 7, debug: true, appearance: { height: 36 } });
  window.mono = actor;
  actor.on('statechange', (value) => { state.textContent = labels[value] ?? value; });
  actor.on('error', (error) => { message.textContent = `${error.code}：${error.message}`; });
  await actor.start();
  await actor.place(panel);
  message.textContent = '人物正在面板上等待。';
}

function run(task: Promise<unknown>): void {
  void task.catch((error: unknown) => { message.textContent = error instanceof Error ? error.message : String(error); });
}

element('restart').onclick = () => { window.demoReady = create(); run(window.demoReady); };
element('jump').onclick = () => { message.textContent = '起跳，重力会带它回来。'; run(actor.requestAction('jump').then(showAction)); };
element('drop').onclick = () => { run(actor.requestAction('fall').then(showAction)); };
element('place-panel').onclick = () => { run(actor.place(panel).then((result) => { message.textContent = result.status === 'placed' ? '回到面板的相对锚点。' : '面板当前不可站立，请先恢复面板。'; })); };
element('place-button').onclick = () => { run(actor.place(landing)); };
element('move').onclick = () => {
  const moving = panel.classList.toggle('moving');
  element('move').textContent = moving ? '停止移动' : '移动面板';
  element('move').setAttribute('aria-pressed', String(moving));
};
element('hide-panel').onclick = () => {
  panel.hidden = !panel.hidden;
  element('hide-panel').textContent = panel.hidden ? '恢复面板' : '隐藏面板';
  element('hide-panel').setAttribute('aria-pressed', String(panel.hidden));
  message.textContent = panel.hidden ? '支撑消失，不等动画结束就开始坠落。' : '面板已恢复，可以重新定位人物。';
};
element('pause').onclick = () => {
  if (actor.getSnapshot().pauses.includes('user')) { actor.resume(); element('pause').textContent = '暂停人物'; }
  else { actor.pause(); element('pause').textContent = '恢复人物'; }
};
element('destroy').onclick = () => { actor.destroy(); message.textContent = '实例已销毁；画布、观察器和帧任务一并释放。'; };
landing.onclick = () => { element('clicks').textContent = String(++clicks); };

const diagnostics = window.setInterval(() => {
  if (!actor) return;
  const snapshot = actor.getSnapshot();
  const p = snapshot.position;
  element('diagnostics').textContent = [
    `动作  ${labels[snapshot.action]}`,
    `根位置  ${p ? `${p.x.toFixed(1)}, ${p.y.toFixed(1)}` : '未创建'}`,
    `支撑  ${snapshot.support?.surfaceId ?? '空中'}`,
    `平台数量  ${snapshot.diagnostics.surfaceCount}`,
    `当前帧  ${snapshot.diagnostics.frameMs.toFixed(2)} ms`,
    `扫描  ${snapshot.diagnostics.scanMs.toFixed(2)} ms`,
    `暂停原因  ${snapshot.pauses.join(', ') || '无'}`,
  ].join('\n');
}, 250);
window.addEventListener('pagehide', () => { clearInterval(diagnostics); actor?.destroy(); }, { once: true });

window.demoReady = create();
run(window.demoReady);

declare global {
  interface Window {
    mono: StickFigure;
    demoReady: Promise<void>;
  }
}
