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
  await page.goto('/examples/');
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
  expect(size!.width).toBe(108);
  await page.getByRole('button', { name: '站到按钮顶部' }).click();
  await page.locator('#landing').click();
  await expect(page.locator('#clicks')).toHaveText('1');
});

test('起跳和落地使用真实平台，根位置不瞬移', async ({ page }) => {
  const before = await snapshot(page);
  await page.getByRole('button', { name: '原地跳跃' }).click();
  await expect.poll(async () => (await snapshot(page)).position!.y).toBeLessThan(before.position!.y - 8);
  await expect.poll(async () => (await snapshot(page)).action, { timeout: 5000 }).toBe('idle');
  const after = await snapshot(page);
  expect(after.support?.surfaceId).toBe(before.support?.surfaceId);
  expect(after.position!.x).toBeCloseTo(before.position!.x, 1);
  expect(after.position!.y).toBeCloseTo(before.position!.y, 1);
});

test('隐藏脚下面板后立即释放接触并落在下方平台', async ({ page }) => {
  const before = await snapshot(page);
  await page.locator('#hide-panel').click();
  await expect.poll(async () => (await snapshot(page)).support?.surfaceId).not.toBe(before.support!.surfaceId);
  await expect.poll(async () => (await snapshot(page)).action, { timeout: 5000 }).toBe('idle');
  const after = await snapshot(page);
  const groundY = await page.locator('#ground').evaluate((node) => node.getBoundingClientRect().top + 1);
  expect(after.position!.y).toBeCloseTo(groundY, 1);
  expect(after.support).not.toBeNull();
});

test('页面滚动与 CSS 平移只补偿一次', async ({ page }) => {
  const before = await snapshot(page);
  await page.evaluate(() => window.scrollTo(0, 150));
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
