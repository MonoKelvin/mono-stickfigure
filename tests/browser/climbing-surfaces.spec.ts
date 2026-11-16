import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import type { SurfaceSnapshot } from '../../src/scene/types';

test.beforeEach(async ({ page }) => {
  await page.goto('/examples/?mode=manual');
  await page.evaluate(async () => { await window.demoReady; window.mono.destroy(); });
});

async function inspect(page: Page, css: string, wrapperCss = '', overlayCss = '', sameBackground = false): Promise<SurfaceSnapshot[]> {
  return page.evaluate(async ({ css, wrapperCss, overlayCss, sameBackground }) => {
    const wrapper = document.createElement('div');
    wrapper.style.cssText = wrapperCss;
    const target = document.createElement('div');
    target.style.cssText = `position:fixed;${css}`;
    if (sameBackground) target.style.backgroundColor = getComputedStyle(document.body).backgroundColor;
    wrapper.append(target);
    if (overlayCss) {
      const overlay = document.createElement('div');
      overlay.style.cssText = `position:fixed;z-index:100;${overlayCss}`;
      wrapper.append(overlay);
    }
    document.body.append(wrapper);
    const modulePath = '/dist/index.mjs';
    const { createStickFigure } = await import(modulePath);
    const actor = createStickFigure({ root: target, debug: true, autonomous: false, motionPreference: 'full', seed: 7 });
    try {
      await actor.start();
      actor.pause();
      await actor.place(target);
      return actor.getSnapshot().surfaces.filter((surface: SurfaceSnapshot) => surface.mode === 'climb');
    } finally {
      actor.destroy();
      wrapper.remove();
    }
  }, { css, wrapperCss, overlayCss, sameBackground });
}

test('纯色填充的真实左右长侧边保留水平面并提供外法向', async ({ page }) => {
  const surfaces = await inspect(page, 'left:300px;top:200px;width:40px;height:160px;background:#222;');
  const valid = surfaces.filter(surface => surface.status === 'valid');
  expect(valid).toHaveLength(2);
  for (const surface of valid) {
    expect(surface.kind).toBe('fill');
    expect(surface.a.y).toBeCloseTo(200);
    expect(surface.b.y).toBeCloseTo(360);
    expect(surface.normal?.y).toBeCloseTo(0);
    expect(Math.abs(surface.normal!.x)).toBeCloseTo(1);
    expect(surface.available).toEqual([{ start: 0, end: 1 }]);
  }
  expect(valid.map(surface => surface.normal!.x).sort()).toEqual([-1, 1]);
});

test('单独 solid 左边框是真实攀爬证据，透明内部不制造填充边', async ({ page }) => {
  const surfaces = await inspect(page, 'left:300px;top:200px;width:40px;height:160px;border-left:2px solid #222;background:transparent;');
  const valid = surfaces.filter(surface => surface.status === 'valid');
  expect(valid).toHaveLength(1);
  expect(valid[0]!.kind).toBe('border');
  expect(valid[0]!.id).toContain(':climb:border-left');
  expect(valid[0]!.normal!.x).toBeCloseTo(-1);
});

test('自身二维旋转恢复 84 度实线真实端点，而非轴对齐外接框', async ({ page }) => {
  const surfaces = await inspect(page, 'left:300px;top:300px;width:170px;height:20px;border-top:2px solid #222;background:transparent;transform:rotate(-84deg);transform-origin:0 0;');
  const valid = surfaces.filter(surface => surface.status === 'valid');
  expect(valid).toHaveLength(1);
  const surface = valid[0]!;
  const dx = surface.b.x - surface.a.x, dy = surface.b.y - surface.a.y;
  expect(Math.hypot(dx, dy)).toBeCloseTo(170, 2);
  expect(Math.atan2(Math.abs(dy), Math.abs(dx)) * 180 / Math.PI).toBeCloseTo(84, 2);
  expect(Math.abs(dx)).toBeGreaterThan(10);
  expect(surface.a.y).toBeLessThan(surface.b.y);
  expect(Math.hypot(surface.normal!.x, surface.normal!.y)).toBeCloseTo(1);
});

test('80 度及以下不是攀爬面，81 度可以识别', async ({ page }) => {
  for (const angle of [79, 80, 81]) {
    const surfaces = await inspect(page, `left:300px;top:300px;width:170px;height:20px;border-top:2px solid #222;transform:rotate(-${angle}deg);transform-origin:0 0;`);
    expect(surfaces.some(surface => surface.status === 'valid')).toBe(angle > 80);
  }
});

test('前后景同色、过短侧边与复杂裁剪不会变成有效攀爬面', async ({ page }) => {
  const same = await inspect(page, 'left:300px;top:200px;width:40px;height:160px;', '', '', true);
  expect(same.some(surface => surface.status === 'valid')).toBe(false);
  const short = await inspect(page, 'left:300px;top:200px;width:40px;height:20px;background:#222;');
  expect(short.some(surface => surface.status === 'valid')).toBe(false);
  const clipped = await inspect(page, 'left:300px;top:200px;width:40px;height:160px;background:#222;clip-path:inset(10px);');
  expect(clipped.some(surface => surface.status === 'valid')).toBe(false);
  expect(clipped.some(surface => surface.status === 'unknown')).toBe(true);
  const threeDimensional = await inspect(page, 'left:300px;top:200px;width:40px;height:160px;border-left:2px solid #222;transform:rotateY(30deg);');
  expect(threeDimensional.some(surface => surface.status === 'valid')).toBe(false);
});

test('真实覆盖元素截断可攀区间，overflow 缩减而不是沿旧矩形攀爬', async ({ page }) => {
  const covered = await inspect(page, 'left:300px;top:200px;width:40px;height:160px;background:#222;', '', 'left:290px;top:250px;width:70px;height:50px;background:#999;');
  const valid = covered.filter(surface => surface.status === 'valid');
  expect(valid).toHaveLength(2);
  for (const surface of valid) {
    expect(surface.available.every(range => range.end <= 0.3126 || range.start >= 0.6249)).toBe(true);
  }
  const clipped = await inspect(page, 'position:absolute;left:40px;top:-30px;width:40px;height:160px;background:#222;', 'position:fixed;left:260px;top:180px;width:180px;height:80px;overflow:hidden;');
  for (const surface of clipped.filter(candidate => candidate.status === 'valid')) {
    expect(surface.available).toHaveLength(1);
    const range = surface.available[0]!;
    expect(surface.a.y + (surface.b.y - surface.a.y) * range.start).toBeCloseTo(180, 2);
    expect(surface.a.y + (surface.b.y - surface.a.y) * range.end).toBeCloseTo(260, 2);
  }
  expect(clipped.some(surface => surface.status === 'valid')).toBe(true);
});
