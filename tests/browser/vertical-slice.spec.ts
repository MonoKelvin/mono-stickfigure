import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import type { StickFigure } from '../../src/types';

declare global {
  interface Window {
    mono: StickFigure;
    demoReady: Promise<void>;
  }
}
const errors = new WeakMap<Page, string[]>();

async function snapshot(page: Page) {
  return page.evaluate(() => window.mono.getSnapshot());
}

test.beforeEach(async ({ page }) => {
  const messages: string[] = [];
  errors.set(page, messages);
  page.on('pageerror', (error) => messages.push(error.message));
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.goto('/examples/?mode=manual');
  await page.evaluate(() => window.demoReady);
  await expect.poll(async () => (await snapshot(page)).status).toBe('running');
});

test.afterEach(async ({ page }) => {
  expect(errors.get(page)).toEqual([]);
});

test('真实边框生成平台，小画布不截获事件', async ({ page }) => {
  const current = await snapshot(page);
  expect(current.support).not.toBeNull();
  expect(current.surfaces.length).toBeGreaterThanOrEqual(1);
  const canvas = page.locator('canvas[data-mono-stickfigure]');
  await expect(canvas).toHaveCount(1);
  await expect(canvas).toHaveCSS('pointer-events', 'none');
  const size = await canvas.boundingBox();
  expect(size!.width).toBe(current.appearance.height * 3);
  expect(current.appearance.height).toBe(16);
  await page.locator('#place-button').click();
  await page.locator('#landing').click();
  await expect(page.locator('#clicks')).toHaveText('1');
});

test('起跳和落地使用真实平台，根位置不瞬移', async ({ page }) => {
  const before = await snapshot(page);
  await page.locator('#jump').click();
  await expect.poll(async () => (await snapshot(page)).position!.y).toBeLessThan(before.position!.y - 8);
  await expect.poll(async () => (await snapshot(page)).action, { timeout: 5000 }).toBe('idle');
  const after = await snapshot(page);
  expect(after.support?.surfaceId).toBe(before.support?.surfaceId);
  expect(after.position!.x).toBeCloseTo(before.position!.x, 1);
  expect(after.position!.y).toBeCloseTo(before.position!.y, 1);
});

test('隐藏脚下面板后立即释放接触并落在下方平台', async ({ page }) => {
  await page.locator('#place-panel').click();
  await expect.poll(async () => (await snapshot(page)).support?.surfaceId).toContain('surface-');
  const before = await snapshot(page);
  await page.locator('#hide-panel').click();
  await expect.poll(async () => (await snapshot(page)).support?.surfaceId).not.toBe(before.support!.surfaceId);
  await expect.poll(async () => (await snapshot(page)).action, { timeout: 5000 }).toBe('idle');
  const after = await snapshot(page);
  const support = after.surfaces.find((surface) => surface.id === after.support!.surfaceId)!;
  expect(after.position!.y).toBeCloseTo(support.a.y, 1);
  expect(after.support).not.toBeNull();
});

test('页面滚动与 CSS 平移只补偿一次', async ({ page }) => {
  await page.locator('#place-panel').click();
  await expect.poll(async () => (await snapshot(page)).support?.surfaceId).toContain('surface-');
  const before = await snapshot(page);
  const scrollY = await page.evaluate(() => window.scrollY);
  await page.evaluate((scrollY) => window.scrollTo(0, scrollY + 150), scrollY);
  await expect.poll(async () => (await snapshot(page)).position!.y).toBeCloseTo(before.position!.y - 150, 1);
  await page.locator('#panel').evaluate((node) => { (node as HTMLElement).style.transform = 'translate(50px, 20px)'; });
  await expect.poll(async () => (await snapshot(page)).position!.x).toBeCloseTo(before.position!.x + 50, 1);
  await expect.poll(async () => (await snapshot(page)).position!.y).toBeCloseTo(before.position!.y - 130, 1);
});

test('透明无边框容器不是平台', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const div = document.createElement('div');
    div.style.cssText = 'position:absolute;left:20px;top:60px;width:100px;height:30px';
    document.getElementById('playground')!.append(div);
    return window.mono.place(div);
  });
  expect(result).toEqual({ status: 'rejected', reason: 'no-visible-support' });
});

test('暂停不会因视口或宿主事件被撤销', async ({ page }) => {
  await page.locator('#pause').click();
  expect((await snapshot(page)).pauses).toContain('user');
  await page.evaluate(() => window.dispatchEvent(new Event('resize')));
  await page.locator('#move').click();
  await expect(page.locator('#state')).toHaveText('已暂停');
  await expect(page.locator('canvas[data-mono-stickfigure]')).toHaveCSS('display', 'none');
  await page.locator('#pause').click();
  await expect.poll(async () => (await snapshot(page)).status).toBe('running');
});

test('销毁可重复，启动中销毁不会复活', async ({ page }) => {
  await page.locator('#destroy').click();
  await expect(page.locator('canvas[data-mono-stickfigure]')).toHaveCount(0);
  const result = await page.evaluate(async () => {
    const entry = '/dist/index.mjs';
    const { createStickFigure } = await import(entry) as typeof import('../../src/index');
    const actor = createStickFigure();
    const first = actor.start();
    const same = first === actor.start();
    actor.destroy();
    actor.destroy();
    let reason = '';
    try { await first; } catch (error) { reason = String(error); }
    return { same, reason, status: actor.getSnapshot().status };
  });
  expect(result.same).toBe(true);
  expect(result.reason).toContain('ABORTED');
  expect(result.status).toBe('destroyed');
  await expect(page.locator('canvas[data-mono-stickfigure]')).toHaveCount(0);
});

test('快照是值副本，不能从外部改写人物坐标', async ({ page }) => {
  const unchanged = await page.evaluate(() => {
    const actor = window.mono;
    const first = actor.getSnapshot();
    const x = first.position!.x;
    first.position!.x = -10000;
    first.surfaces[0]!.a.x = -10000;
    return actor.getSnapshot().position!.x === x;
  });
  expect(unchanged).toBe(true);
});

test('默认自由活动产生连续随机行走，关闭后制动且暂停不漂移', async ({ page }) => {
  await page.goto('/examples/');
  await page.evaluate(() => window.demoReady);
  expect((await snapshot(page)).autonomous).toBe(true);
  await page.waitForFunction(() => window.mono.getSnapshot().action === 'walk');
  const samples = await page.evaluate(async () => {
    const samples: { x: number; support: string | undefined }[] = [];
    for (let i = 0; i < 70; i++) {
      await new Promise(requestAnimationFrame);
      const state = window.mono.getSnapshot();
      samples.push({ x: state.position!.x, support: state.support?.surfaceId });
    }
    return samples;
  });
  expect(Math.abs(samples.at(-1)!.x - samples[0]!.x)).toBeGreaterThan(15);
  expect(samples.every((sample) => sample.support === samples[0]!.support)).toBe(true);
  expect(samples.slice(1).every((sample, i) => Math.abs(sample.x - samples[i]!.x) < 6)).toBe(true);
  await page.locator('#autonomy').click();
  await expect.poll(async () => Math.abs((await snapshot(page)).velocity.x)).toBeLessThan(0.5);
  expect((await snapshot(page)).autonomous).toBe(false);
  await page.locator('#pause').click();
  const stopped = (await snapshot(page)).position;
  await page.evaluate(async () => { for (let i = 0; i < 20; i++) await new Promise(requestAnimationFrame); });
  expect((await snapshot(page)).position).toEqual(stopped);
});

test('真实跳跃逐帧符合恒定重力公式并回到原支撑', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const before = window.mono.getSnapshot();
    const action = window.mono.requestAction('jump');
    const samples: { y: number; vy: number; airborne: boolean }[] = [];
    for (let i = 0; i < 100; i++) {
      await new Promise(requestAnimationFrame);
      const state = window.mono.getSnapshot();
      samples.push({ y: state.position!.y, vy: state.velocity.y, airborne: !state.support });
      if (i > 10 && state.action === 'idle') break;
    }
    return { before, samples, action: await action, after: window.mono.getSnapshot() };
  });
  const gravity = result.before.physics.gravity;
  const upward = Math.sqrt(2 * gravity * result.before.physics.jumpHeight);
  const air = result.samples.filter((sample) => sample.airborne);
  expect(air.some((sample) => sample.vy < 0)).toBe(true);
  expect(air.some((sample) => sample.vy > 0)).toBe(true);
  for (const sample of air) {
    const time = (sample.vy + upward) / gravity;
    expect(sample.y).toBeCloseTo(result.before.position!.y - upward * time + gravity * time ** 2 / 2, 5);
  }
  expect(result.before.position!.y - Math.min(...air.map((sample) => sample.y))).toBeCloseTo(52, 0);
  expect(result.action.status).toBe('completed');
  expect(result.after.support?.surfaceId).toBe(result.before.support?.surfaceId);
});

test('手动行走在真实边缘停止，不越过脚部支撑范围', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const actor = window.mono;
    const id = actor.getSnapshot().support!.surfaceId;
    await actor.place({ surfaceId: id, u: 0.94 });
    const action = await actor.requestAction('walk', { direction: 1, duration: 2 });
    return { action, state: actor.getSnapshot() };
  });
  const surface = result.state.surfaces.find((surface) => surface.id === result.state.support!.surfaceId)!;
  expect(result.action).toEqual({ status: 'completed', reason: 'edge' });
  expect(result.state.velocity.x).toBe(0);
  expect(result.state.position!.x).toBeLessThanOrEqual(surface.b.x - result.state.appearance.height * 0.26 + 1e-6);
});

test('整页的文章、表格、树、表单、滚动条目和页眉页脚都可定位', async ({ page }) => {
  for (const id of ['article-platform', 'table-cell', 'tree-node', 'field-platform', 'scroll-item', 'footer-platform', 'header-platform']) {
    await page.locator(`#${id}`).scrollIntoViewIfNeeded();
    const result = await page.evaluate(async (id) => {
      const target = document.getElementById(id)!;
      await new Promise(requestAnimationFrame);
      return window.mono.place(target);
    }, id);
    expect(result.status, id).toBe('placed');
    expect((await snapshot(page)).support, id).not.toBeNull();
  }
});

test('折叠真实目录使仍连接的子节点失去支撑并自然落下', async ({ page }) => {
  await page.locator('[data-place="tree-node"]').click();
  await expect.poll(async () => (await snapshot(page)).status).toBe('running');
  const before = await snapshot(page);
  await page.locator('#collapse-tree').click();
  expect(await page.locator('#tree-node').evaluate((node) => node.isConnected)).toBe(true);
  await expect.poll(async () => (await snapshot(page)).support?.surfaceId).not.toBe(before.support!.surfaceId);
  await expect.poll(async () => (await snapshot(page)).action, { timeout: 5000 }).toBe('idle');
  expect((await snapshot(page)).support).not.toBeNull();
});

test('嵌套滚动保留相对接触，离屏暂停后能恢复', async ({ page }) => {
  await page.locator('[data-place="scroll-item"]').click();
  await expect.poll(async () => (await snapshot(page)).status).toBe('running');
  const before = await snapshot(page);
  await page.locator('#scroll-container').evaluate((node) => { node.scrollTop = 20; });
  await expect.poll(async () => (await snapshot(page)).position!.y).toBeCloseTo(before.position!.y - 20, 1);
  expect((await snapshot(page)).support?.surfaceId).toBe(before.support!.surfaceId);
  await page.locator('#scroll-container').evaluate((node) => { node.scrollTop = 300; });
  await expect.poll(async () => (await snapshot(page)).pauses).toContain('offscreen');
  await page.locator('#scroll-container').evaluate((node) => { node.scrollTop = 0; });
  await expect.poll(async () => (await snapshot(page)).status).toBe('running');
  expect((await snapshot(page)).support?.surfaceId).toBe(before.support!.surfaceId);
});

test('手机宽度下移动面板不产生水平溢出，大小与重力控件可用', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('#move').click();
  const overflow = await page.evaluate(async () => {
    for (let i = 0; i < 100; i++) {
      await new Promise(requestAnimationFrame);
      if (document.documentElement.scrollWidth > innerWidth) return true;
    }
    return false;
  });
  expect(overflow).toBe(false);
  await page.locator('#size').press('Home');
  await page.evaluate(() => window.demoReady);
  await page.locator('#size').press('ArrowRight');
  await page.evaluate(() => window.demoReady);
  await expect.poll(async () => (await snapshot(page)).appearance.height).toBe(16);
  await expect(page.locator('canvas[data-mono-stickfigure]')).toHaveCSS('width', '48px');
  await page.locator('.settings-panel > summary').click();
  await page.locator('#gravity').evaluate((input) => {
    const control = input as HTMLInputElement;
    control.value = '490';
    control.dispatchEvent(new Event('input', { bubbles: true }));
    control.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await page.evaluate(() => window.demoReady);
  expect((await snapshot(page)).physics).toEqual({ gravity: 490, jumpHeight: 52 });
});

test('宿主表单正常提交，reduced-motion 下不进行自由行走', async ({ page }) => {
  await page.locator('#field-platform').fill('小白');
  await page.locator('#submit-platform').click();
  await expect(page.locator('#form-result')).toContainText('小白');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.locator('#autonomy').click();
  await expect.poll(async () => (await snapshot(page)).status).toBe('running');
  await expect.poll(async () => (await snapshot(page)).action).toBe('idle');
  const action = await page.evaluate(() => window.mono.requestAction('walk'));
  expect(action).toEqual({ status: 'rejected', reason: 'reduced-motion' });
});
