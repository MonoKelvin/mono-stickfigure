import { expect, test } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.goto('/examples/?mode=manual');
  await page.evaluate(() => window.demoReady);
});

test('版本显示来自包，连续重力不量化为档位', async ({ page }) => {
  const version = await page.evaluate(async () => (await import('../../dist/index.mjs')).VERSION);
  await expect(page.locator('.version')).toHaveText(`v${version}`);
  await page.locator('#gravity').evaluate((input: HTMLInputElement) => {
    input.value = '12.345';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await page.evaluate(() => window.demoReady);
  expect(await page.evaluate(() => window.mono.getSnapshot().physics.gravity)).toBe(12.345);
});

test('坐姿、疑问和原地跑通过真实按钮完成且根不漂移', async ({ page }) => {
  await page.locator('#size').evaluate((input: HTMLInputElement) => {
    input.value = '40';
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await page.evaluate(() => window.demoReady);
  for (const id of ['sit', 'question', 'run-in-place']) {
    await page.locator('[data-place="action-runway"]').first().click();
    await page.waitForFunction(() => window.mono.getSnapshot().support !== null);
    const before = await page.evaluate(() => window.mono.getSnapshot().position!);
    await page.locator(`#${id}`).click();
    await page.waitForFunction((action) => window.mono.getSnapshot().action === action, id);
    const samples = await page.evaluate(async () => {
      const points = [];
      for (let i = 0; i < 20; i++) {
        await new Promise(requestAnimationFrame);
        points.push(window.mono.getSnapshot().position!);
      }
      return points;
    });
    expect(samples.every(point => Math.abs(point.x - before.x) < 0.01 && Math.abs(point.y - before.y) < 0.01)).toBe(true);
    await page.screenshot({ path: test.info().outputPath(`${id}.png`), clip: { x: before.x - 60, y: before.y - 100, width: 120, height: 120 } });
    await page.waitForFunction(() => (document.getElementById('cancel-action') as HTMLButtonElement).disabled);
    await expect(page.locator('#message')).toContainText('已完成');
  }
});

for (const [button, name] of [['demo-climb', '竖墙'], ['demo-slope', '84°陡斜边']] as const) {
  test(`${name}从平台抓附、攀爬后真实跳回平台`, async ({ page }) => {
    test.setTimeout(60000);
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.evaluate(() => {
      const actions: string[] = [];
      window.mono.on('actionchange', ({ action }) => actions.push(action));
      (window as unknown as { v1Actions: string[] }).v1Actions = actions;
    });
    await page.locator(`#${button}`).click();
    await page.waitForFunction(() => window.mono.getSnapshot().climb !== null, undefined, { timeout: 15000 });
    const attached = await page.evaluate(() => window.mono.getSnapshot());
    expect(attached.support).toBeNull();
    expect(attached.climb!.normal.x).toBeLessThan(0);
    expect(attached.surfaces.find(surface => surface.id === attached.climb!.surfaceId)?.mode).toBe('climb');
    await page.screenshot({ path: test.info().outputPath(`${button}-attached.png`), clip: { x: attached.position!.x - 32, y: attached.position!.y - 42, width: 64, height: 64 } });
    await page.waitForFunction((y) => window.mono.getSnapshot().climb !== null && Math.abs(window.mono.getSnapshot().position!.y - y) > 10, attached.position!.y);
    const middle = await page.evaluate(() => window.mono.getSnapshot().position!);
    await page.screenshot({ path: test.info().outputPath(`${button}-middle.png`), clip: { x: middle.x - 32, y: middle.y - 42, width: 64, height: 64 } });
    await page.waitForFunction(() => (document.getElementById('cancel-action') as HTMLButtonElement).disabled, undefined, { timeout: 40000 });
    await expect(page.locator('#message')).toContainText('已完成');
    const ended = await page.evaluate(() => ({ snapshot: window.mono.getSnapshot(), actions: (window as unknown as { v1Actions: string[] }).v1Actions }));
    expect(ended.snapshot.climb).toBeNull();
    expect(ended.snapshot.support).not.toBeNull();
    expect(ended.actions).toContain('climb');
    expect(ended.actions.filter(action => ['jump', 'run-jump', 'running-long-jump'].includes(action)).length).toBeGreaterThanOrEqual(2);
    expect(errors).toEqual([]);
  });
}

test('双手先抓稳再贴脚，慢速攀爬保持真实接触', async ({ page }) => {
  test.setTimeout(30000);
  await page.locator('#size').evaluate((input: HTMLInputElement) => {
    input.value = '24';
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await page.evaluate(() => window.demoReady);
  await page.locator('[data-place="climb-start"]').click();
  await page.waitForFunction(() => window.mono.getSnapshot().status === 'running' && window.mono.getSnapshot().support !== null);
  const pending = page.evaluate(async () => {
    const abort = new AbortController();
    (window as unknown as { climbAbort: AbortController }).climbAbort = abort;
    return window.mono.requestAction('climb', { target: document.getElementById('climb-wall')!, signal: abort.signal });
  });
  await page.waitForFunction(() => window.mono.getSnapshot().climb !== null, undefined, { timeout: 15000 });
  const attached = await page.evaluate(() => window.mono.getSnapshot());
  const captures: { phase: string; position: { x: number; y: number }; u: number; speed: number; status: string }[] = [];
  const capture = async (name: string) => {
    const state = await page.evaluate(() => window.mono.getSnapshot());
    expect(state.climb).not.toBeNull();
    const speed = Math.hypot(state.velocity.x, state.velocity.y);
    expect(speed).toBeLessThanOrEqual(state.appearance.height * 0.4 + 1e-6);
    captures.push({ phase: name, position: state.position!, u: state.climb!.u, speed, status: state.navigation.status });
    await page.screenshot({ path: test.info().outputPath(`${name}.png`), clip: { x: state.position!.x - 64, y: state.position!.y - 112, width: 128, height: 160 } });
  };
  await capture('both-hands-grab');
  await page.evaluate(async () => { for (let i = 0; i < 12; i++) await new Promise(requestAnimationFrame); });
  await capture('feet-to-wall');
  await page.waitForFunction((y) => window.mono.getSnapshot().climb !== null && window.mono.getSnapshot().position!.y < y - 0.2, attached.position!.y);
  await capture('slow-first-step');
  await page.evaluate(async () => { for (let i = 0; i < 24; i++) await new Promise(requestAnimationFrame); });
  await capture('three-point-climb');
  await page.evaluate(() => (window as unknown as { climbAbort: AbortController }).climbAbort.abort());
  const result = await pending;
  if (result.status === 'interrupted') expect(result.reason).toBe('aborted');
  else expect(result.status).toBe('completed');
  expect((await page.evaluate(() => window.mono.getSnapshot())).climb).not.toBeNull();
  await test.info().attach('climb-captures', { body: JSON.stringify(captures), contentType: 'application/json' });
});

test('最高重力的限速高落地同一步翻滚，不先行走或缓冲', async ({ page }) => {
  await page.evaluate(() => {
    const size = document.getElementById('size') as HTMLInputElement;
    const gravity = document.getElementById('gravity') as HTMLInputElement;
    size.value = '28';
    gravity.value = '20';
    gravity.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await page.evaluate(() => window.demoReady);
  await page.evaluate(async () => {
    document.getElementById('route-terrain')!.scrollIntoView({ block: 'center', behavior: 'instant' });
    for (let i = 0; i < 3; i++) await new Promise(requestAnimationFrame);
    const source = document.getElementById('drop-source')!;
    window.mono.pause();
    await window.mono.place(source.querySelector('span')!);
    await window.mono.place(source);
    window.mono.resume();
  });
  await page.evaluate(() => {
    const actions: string[] = [];
    window.mono.on('actionchange', ({ action }) => actions.push(action));
    (window as unknown as { rollActions: string[] }).rollActions = actions;
  });
  await page.locator('#demo-drop').click();
  await page.waitForFunction(() => window.mono.getSnapshot().action === 'roll');
  for (const phase of ['start', 'shoulder', 'middle']) {
    const state = await page.evaluate(() => window.mono.getSnapshot());
    expect(state.support).not.toBeNull();
    const surface = state.surfaces.find(candidate => candidate.id === state.support!.surfaceId)!;
    expect(state.position!.y).toBeCloseTo(surface.a.y, 6);
    await page.screenshot({ path: test.info().outputPath(`roll-${phase}.png`), clip: { x: state.position!.x - 48, y: state.position!.y - 70, width: 96, height: 96 } });
    await page.evaluate(async () => { for (let i = 0; i < 9; i++) await new Promise(requestAnimationFrame); });
  }
  await page.waitForFunction(() => (document.getElementById('cancel-action') as HTMLButtonElement).disabled);
  await expect(page.locator('#message')).toContainText('已完成');
  const actions = await page.evaluate(() => (window as unknown as { rollActions: string[] }).rollActions);
  const fall = actions.indexOf('fall'), roll = actions.indexOf('roll');
  expect(fall).toBeGreaterThanOrEqual(0);
  expect(roll).toBe(fall + 1);
});

test('80°边段不伪装成可攀爬斜坡', async ({ page }) => {
  await page.locator('#climb-terrain').scrollIntoViewIfNeeded();
  await page.evaluate(() => window.mono.place(document.getElementById('slope-start')!));
  await page.waitForFunction(() => window.mono.getSnapshot().status === 'running' && window.mono.getSnapshot().support !== null);
  const result = await page.evaluate(async () => window.mono.requestAction('climb', { target: document.getElementById('slope-limit')! }));
  expect(result).toEqual({ status: 'rejected', reason: 'no-visible-climb' });
});

test('有限下落速度在真实运行时生效，取消不冻结空中物理', async ({ page }) => {
  const result = await page.evaluate(async () => {
    window.mono.destroy();
    const { createStickFigure } = await import('../../dist/index.mjs');
    const host = document.createElement('div');
    host.style.cssText = 'position:fixed;left:20px;top:80px;width:220px;height:600px;z-index:2000';
    const stand = document.createElement('div');
    stand.style.cssText = 'width:220px;height:1px;border-top:2px solid #181818';
    host.append(stand);
    document.body.append(host);
    const actor = createStickFigure({ root: host, autonomous: false, motionPreference: 'full', physics: { maxFallSpeed: 180 }, boundary: { wrapX: false, wrapY: false } });
    await actor.start();
    const placed = await actor.place(stand);
    if (placed.status !== 'placed') throw new Error(`测试平台无法识别：${placed.reason}`);
    const abort = new AbortController();
    const falling = actor.requestAction('fall', { signal: abort.signal });
    const speeds: number[] = [];
    for (let i = 0; i < 35; i++) {
      await new Promise(requestAnimationFrame);
      speeds.push(actor.getSnapshot().velocity.y);
    }
    const before = actor.getSnapshot().position!.y;
    abort.abort();
    const cancelled = await falling;
    for (let i = 0; i < 8; i++) await new Promise(requestAnimationFrame);
    const after = actor.getSnapshot().position!.y;
    actor.destroy();
    host.remove();
    return { speeds, before, after, cancelled };
  });
  expect(Math.max(...result.speeds)).toBeCloseTo(180, 6);
  expect(result.speeds.every(speed => speed <= 180)).toBe(true);
  expect(result.after).toBeGreaterThan(result.before);
  expect(result.cancelled).toEqual({ status: 'interrupted', reason: 'aborted' });
});

test('取消攀爬保留真实锚点，滚动跟随且隐藏墙后释放', async ({ page }) => {
  test.setTimeout(30000);
  await page.locator('[data-place="climb-start"]').click();
  await page.waitForFunction(() => window.mono.getSnapshot().status === 'running' && window.mono.getSnapshot().support !== null);
  const pending = page.evaluate(async () => {
    const abort = new AbortController();
    (window as unknown as { climbAbort: AbortController }).climbAbort = abort;
    return window.mono.requestAction('climb', { target: document.getElementById('climb-wall')!, signal: abort.signal });
  });
  await page.waitForFunction(() => window.mono.getSnapshot().climb !== null, undefined, { timeout: 15000 });
  await page.evaluate(() => (window as unknown as { climbAbort: AbortController }).climbAbort.abort());
  expect(await pending).toEqual({ status: 'interrupted', reason: 'aborted' });
  const before = await page.evaluate(() => window.mono.getSnapshot());
  expect(before.climb).not.toBeNull();
  await page.evaluate(() => scrollBy({ top: 40, behavior: 'instant' }));
  await page.waitForFunction((y) => Math.abs(window.mono.getSnapshot().position!.y - (y - 40)) < 0.1, before.position!.y);
  const moved = await page.evaluate(() => window.mono.getSnapshot());
  expect(moved.climb).toEqual(before.climb);
  await page.locator('#climb-wall').evaluate((wall: HTMLElement) => { wall.style.visibility = 'hidden'; });
  await page.waitForFunction(() => window.mono.getSnapshot().climb === null);
  expect((await page.evaluate(() => window.mono.getSnapshot())).support).toBeNull();
});

test('攀爬中遇到未知裁剪保持锚点并待验证，恢复后不崩溃', async ({ page }) => {
  test.setTimeout(30000);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.locator('[data-place="climb-start"]').click();
  await page.waitForFunction(() => window.mono.getSnapshot().status === 'running' && window.mono.getSnapshot().support !== null);
  const pending = page.evaluate(async () => {
    const abort = new AbortController();
    (window as unknown as { climbAbort: AbortController }).climbAbort = abort;
    return window.mono.requestAction('climb', { target: document.getElementById('climb-wall')!, signal: abort.signal });
  });
  await page.waitForFunction(() => window.mono.getSnapshot().climb !== null, undefined, { timeout: 15000 });
  const id = await page.evaluate(() => window.mono.getSnapshot().climb!.surfaceId);
  await page.locator('#climb-wall').evaluate((wall: HTMLElement) => { wall.style.clipPath = 'inset(1px)'; });
  await page.waitForFunction(() => window.mono.getSnapshot().pauses.includes('verification'));
  expect((await page.evaluate(() => window.mono.getSnapshot())).climb!.surfaceId).toBe(id);
  await page.evaluate(() => (window as unknown as { climbAbort: AbortController }).climbAbort.abort());
  expect(await pending).toEqual({ status: 'interrupted', reason: 'aborted' });
  await page.locator('#climb-wall').evaluate((wall: HTMLElement) => { wall.style.removeProperty('clip-path'); });
  await page.waitForFunction(() => window.mono.getSnapshot().status === 'running');
  expect((await page.evaluate(() => window.mono.getSnapshot())).climb!.surfaceId).toBe(id);
  expect(errors).toEqual([]);
});

test('滚动后下落不捕获上一屏缓存的平台坐标', async ({ page }) => {
  const result = await page.evaluate(async () => {
    window.mono.destroy();
    const { createStickFigure } = await import('../../dist/index.mjs');
    const host = document.createElement('div');
    host.style.cssText = 'position:absolute;left:20px;top:0;width:500px;height:10000px;z-index:2000';
    const floors = [150, 500, 700].map(top => {
      const element = document.createElement('div');
      element.style.cssText = `position:absolute;left:200px;top:${top}px;width:200px;height:12px;border-top:2px solid #181818`;
      host.append(element);
      return element;
    });
    document.body.append(host);
    scrollTo({ top: 0, behavior: 'instant' });
    const actor = createStickFigure({ root: host, autonomous: false, debug: true, motionPreference: 'full' });
    await actor.start();
    await actor.place(floors[0]!);
    actor.pause();
    scrollTo({ top: 450, behavior: 'instant' });
    for (let i = 0; i < 3; i++) await new Promise(requestAnimationFrame);
    await actor.place(floors[2]!);
    const destination = actor.getSnapshot().support!.surfaceId;
    await actor.place(floors[1]!);
    actor.resume();
    for (let i = 0; i < 3; i++) await new Promise(requestAnimationFrame);
    const falling = await actor.requestAction('fall');
    const snapshot = actor.getSnapshot();
    const y = floors[2]!.getBoundingClientRect().top + 1;
    actor.destroy();
    host.remove();
    return { falling, snapshot, destination, y };
  });
  expect(result.falling.status).toBe('completed');
  expect(result.snapshot.support!.surfaceId).toBe(result.destination);
  expect(result.snapshot.position!.y).toBeCloseTo(result.y, 4);
});

test('单平台自主到达后立即选新目标，诊断定长且可复制', async ({ page }) => {
  test.setTimeout(45000);
  const result = await page.evaluate(async () => {
    window.mono.destroy();
    const { createStickFigure } = await import('../../dist/index.mjs');
    const host = document.createElement('div');
    host.style.cssText = 'position:fixed;left:20px;top:250px;width:600px;height:2px;z-index:2000;border-top:2px solid #181818';
    document.body.append(host);
    const actor = createStickFigure({ root: host, seed: 42, autonomous: true, debug: true, motionPreference: 'full', performance: { navigationBudgetMs: 0.25 } });
    const arrivals: { hasTarget: boolean; goalId: number }[] = [];
    actor.on('navigationchange', decision => {
      if (decision.status === 'arrived' && !arrivals.length) arrivals.push({ hasTarget: actor.getSnapshot().target !== null, goalId: actor.getSnapshot().navigation.goalId });
    });
    await actor.start();
    for (let i = 0; i < 1500 && !arrivals.length; i++) await new Promise(requestAnimationFrame);
    const snapshot = actor.getSnapshot();
    const reached = snapshot.navigation.history.find(decision => decision.status === 'arrived');
    const targets = snapshot.navigation.history.filter(decision => decision.reason === 'target-selected');
    const copy = actor.getSnapshot();
    if (copy.navigation.history[0]?.target) copy.navigation.history[0].target.x = -10000;
    const safe = actor.getSnapshot().navigation.history.every(decision => decision.target?.x !== -10000);
    actor.setAutonomous(false);
    actor.destroy();
    host.remove();
    return { arrival: arrivals[0] ?? null, reached, targets, safe, historyLength: snapshot.navigation.history.length, candidates: snapshot.navigation.candidates };
  });
  expect(result.arrival).not.toBeNull();
  expect(result.arrival!.hasTarget).toBe(true);
  expect(result.arrival!.goalId).toBeGreaterThan(result.reached!.id);
  expect(result.targets.length).toBeGreaterThanOrEqual(2);
  expect(result.safe).toBe(true);
  expect(result.historyLength).toBeLessThanOrEqual(32);
  expect(result.candidates).toBeLessThanOrEqual(64);
});
