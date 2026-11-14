import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const run = process.env.MONO_VERIFY_RUN ?? String(Date.now());
if (!/^[\w-]+$/.test(run)) throw new Error('MONO_VERIFY_RUN 只能使用字母、数字、下划线或连字符');
const output = new URL(`../.artifacts/demo-${run}/`, import.meta.url);
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ channel: 'msedge', headless: false });
const report = {
  run, browser: browser.version(), os: process.platform, node: process.version, profiles: [],
  note: '真实 example 按钮与公共 API；390 px 和 200% 仅桌面布局检查。frameMs 扣除 scanMs，不是整页帧耗时或正式性能验收。',
};
const path = (name) => fileURLToPath(new URL(name, output));

try {
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
    const context = await browser.newContext({ viewport, reducedMotion: 'no-preference', recordVideo: { dir: path('video/'), size: viewport } });
    const page = await context.newPage();
    const errors = [];
    const lifecycle = [];
    let closing = false;
    const profile = { width: viewport.width, actions: [], checks: {}, pageErrors: errors, lifecycle };
    report.profiles.push(profile);
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('close', () => lifecycle.push({ event: 'close', expected: closing, at: Date.now() }));
    page.on('crash', () => lifecycle.push({ event: 'crash', at: Date.now() }));
    page.on('framenavigated', (frame) => {
      if (frame === page.mainFrame()) lifecycle.push({ event: 'navigation', at: Date.now() });
    });
    page.on('websocket', (socket) => socket.on('framereceived', ({ payload }) => {
      const message = JSON.parse(String(payload));
      if (message.type === 'full-reload') lifecycle.push({ event: 'full-reload', path: message.path, at: Date.now() });
    }));
    page.setDefaultTimeout(15000);

    const screenshot = (name) => page.screenshot({ path: path(`${viewport.width}-${name}.png`) });
    const settled = () => page.waitForFunction(() => {
      const s = window.mono.getSnapshot();
      return s.status === 'running' && s.support !== null && s.action === 'idle';
    }, undefined, { timeout: 20000 });
    const record = () => page.evaluate(() => {
      window.demoCheck?.unsubscribe();
      const s = window.mono.getSnapshot();
      window.demoCheck = { actions: [s.action], unsubscribe: window.mono.on('actionchange', ({ action }) => {
        if (window.demoCheck.actions.at(-1) !== action) window.demoCheck.actions.push(action);
      }) };
    });
    const sequence = () => page.evaluate(() => [...window.demoCheck.actions]);
    const place = async (id) => {
      const selector = { panel: '#place-panel', landing: '#place-button' }[id] ?? `button[data-place="${id}"]`;
      await page.locator(selector).click();
      await page.evaluate(async () => {
        for (let i = 0; i < 3; i++) await new Promise(requestAnimationFrame);
      });
      await page.waitForFunction(() => window.mono.getSnapshot().support !== null && document.getElementById('message').textContent.startsWith('已站到'));
      await settled();
      return page.evaluate(() => {
        const s = window.mono.getSnapshot();
        return { support: s.support, position: s.position, surface: s.surfaces.find((surface) => surface.id === s.support.surfaceId) };
      });
    };
    const request = async (id, capture) => {
      await record();
      await page.locator(`#${id}`).click();
      if (capture === 'jump') {
        await page.waitForFunction(() => window.mono.getSnapshot().action === 'anticipate');
        await screenshot('jump-start');
        await page.waitForFunction(() => window.mono.getSnapshot().action === 'jump' && window.mono.getSnapshot().velocity.y < 0);
        await screenshot('jump-airborne');
      } else if (capture === 'roll') {
        await page.waitForFunction(() => window.mono.getSnapshot().action === 'roll');
        const x = await page.evaluate(() => window.mono.getSnapshot().position.x);
        await screenshot('roll-start');
        await page.waitForFunction((start) => window.mono.getSnapshot().action === 'roll' && Math.abs(window.mono.getSnapshot().position.x - start) > 10, x);
        await screenshot('roll-middle');
      }
      await page.waitForFunction(() => document.getElementById('cancel-action').disabled && !document.getElementById('message').textContent.includes('正在出发'), undefined, { timeout: 60000 });
      const message = await page.locator('#message').textContent();
      const actions = await sequence();
      if (id === 'running-long-jump' && viewport.width === 390) {
        assert.ok(message.includes('已完成') || message.includes('人物已离开当前视口'), message);
        assert.ok(actions.includes('sprint') && actions.includes('running-long-jump'), actions.join(' → '));
      } else assert.ok(message.includes('已完成'), message);
      await settled();
      if (capture) await screenshot(`${capture}-end`);
      return { id, message, sequence: actions };
    };

    try {
      await page.goto('http://127.0.0.1:5173/examples/?mode=manual');
      await page.evaluate(() => window.demoReady);
      await settled();
      assert.equal(await page.evaluate(() => window.mono.getSnapshot().appearance.height), 18);
      assert.equal(await page.evaluate(() => window.mono.getSnapshot().autonomous), false);
      const start = await page.evaluate(() => window.mono.start());
      assert.equal(start.supportedActions.length, 16);
      assert.equal(await page.locator('.action-button').count(), 16);
      assert.equal(await page.locator('.action-button').evaluateAll((buttons) => buttons.some((button) => button.closest('details'))), false);
      await screenshot('top');
      const text = await place('text-runway');
      assert.equal(text.surface.kind, 'text');
      profile.checks.text = { kind: text.surface.kind, evidence: text.surface.evidence };

      for (const id of ['idle', 'walk', 'run', 'sprint', 'turn', 'jump', 'run-jump', 'running-long-jump', 'drop', 'land-soft', 'roll', 'wave', 'crouch', 'rest', 'prone', 'stand-up']) {
        await place('action-runway');
        profile.actions.push(await request(id, viewport.width === 1440 && (id === 'jump' || id === 'roll') ? id : undefined));
      }

      const grounded = await place('action-runway');
      const scroll = await page.evaluate(() => scrollY);
      await page.evaluate(() => scrollTo({ top: document.documentElement.scrollHeight, behavior: 'instant' }));
      await page.waitForFunction(() => window.mono.getSnapshot().pauses.includes('offscreen'));
      const offscreen = await page.evaluate(() => window.mono.getSnapshot());
      assert.deepEqual(offscreen.support, grounded.support);
      await page.evaluate((top) => scrollTo({ top, behavior: 'instant' }), scroll);
      await settled();
      const returned = await page.evaluate(() => window.mono.getSnapshot());
      assert.deepEqual(returned.support, grounded.support);
      assert.ok(Math.abs(returned.position.y - grounded.position.y) < 1);
      profile.checks.documentScrollAnchor = 'passed';

      const highDrop = await request('demo-drop');
      assert.ok(highDrop.sequence.includes('land-soft') && highDrop.sequence.includes('roll'), highDrop.sequence.join(' → '));
      profile.checks.highDrop = highDrop;
      await screenshot('terrain');
      await page.locator('#route-pace').selectOption('sprint');
      for (const id of ['demo-route', 'demo-point']) profile.checks[id] = await request(id);
      await page.locator('#demo-route').click();
      await page.waitForFunction(() => window.mono.getSnapshot().target !== null && window.mono.getSnapshot().action !== 'idle');
      await page.locator('#cancel-route').click();
      await page.waitForFunction(() => document.getElementById('cancel-route').disabled && document.getElementById('route-message').textContent.includes('已取消'));
      await page.evaluate(() => document.getElementById('route-terrain').scrollIntoView({ block: 'center', behavior: 'instant' }));
      await settled();
      assert.equal(await page.evaluate(() => window.mono.getSnapshot().target), null);
      profile.checks.cancelRoute = 'passed';

      await place('panel');
      const panelStartX = await page.evaluate(() => window.mono.getSnapshot().position.x);
      await page.locator('#move').click();
      await page.waitForFunction((x) => Math.abs(window.mono.getSnapshot().position.x - x) > 4, panelStartX);
      const moving = await page.evaluate(async (startX) => {
        const samples = [];
        for (let i = 0; i < 60; i++) {
          await new Promise(requestAnimationFrame);
          const s = window.mono.getSnapshot();
          const box = document.getElementById('panel').getBoundingClientRect();
          samples.push({ x: s.position.x, error: Math.abs(s.position.x - box.left - s.support.u * box.width), support: s.support });
        }
        return { distance: Math.abs(samples.at(-1).x - startX), maxError: Math.max(...samples.map((sample) => sample.error)), sameAnchor: samples.every((sample) => JSON.stringify(sample.support) === JSON.stringify(samples[0].support)) };
      }, panelStartX);
      assert.ok(moving.distance > 1 && moving.maxError < 1 && moving.sameAnchor, JSON.stringify(moving));
      profile.checks.movingPanel = moving;
      await page.locator('#move').click();
      await record();
      await page.locator('#hide-panel').click();
      await page.waitForFunction(() => window.demoCheck.actions.includes('fall'));
      await settled();
      profile.checks.hiddenPanel = 'passed';
      await page.locator('#hide-panel').click();
      await place('landing');
      await page.locator('#landing').click();
      assert.equal(await page.locator('#clicks').textContent(), '1');
      profile.checks.hostClick = 'passed';

      const color = await place('color-probe');
      await record();
      await page.evaluate(() => { document.getElementById('color-probe').style.backgroundColor = getComputedStyle(document.body).backgroundColor; });
      await page.waitForFunction((id) => window.mono.getSnapshot().support?.surfaceId !== id && window.demoCheck.actions.includes('fall'), color.support.surfaceId);
      await page.locator('button[data-place="color-probe"]').click();
      await page.waitForFunction(() => document.getElementById('message').textContent.includes('不能站立'));
      profile.checks.sameColor = 'passed';
      await page.evaluate(() => { document.getElementById('color-probe').style.removeProperty('background-color'); });
      await place('color-probe');

      const tree = await place('tree-node');
      await record();
      await page.locator('#collapse-tree').click();
      await page.waitForFunction((id) => !document.getElementById('tree-branch').open && window.demoCheck.actions.includes('fall') && window.mono.getSnapshot().support?.surfaceId !== id, tree.support.surfaceId);
      await settled();
      const collapsed = await page.evaluate(() => window.mono.place(document.getElementById('tree-node')));
      assert.equal(collapsed.status, 'rejected');
      const summary = await page.evaluate(() => window.mono.place(document.querySelector('#tree-branch > summary')));
      assert.equal(summary.status, 'placed');
      await page.locator('#collapse-tree').click();
      const reopened = await place('tree-node');
      assert.equal(reopened.support.surfaceId, tree.support.surfaceId);
      assert.ok(reopened.support.sourceRevision > tree.support.sourceRevision);
      profile.checks.collapsedTree = 'passed';
      await page.locator('#field-platform').fill('墨线');
      await page.locator('#topic').selectOption({ label: '目录树' });
      await page.locator('#submit-platform').click();
      assert.ok((await page.locator('#form-result').textContent()).includes('墨线，今天想逛目录树'));
      profile.checks.hostForm = 'passed';
      await page.locator('#test-transparent').click();
      await page.waitForFunction(() => document.getElementById('message').textContent.includes('不能站立'));
      profile.checks.transparent = 'passed';

      await place('scroll-item');
      const nested = await page.evaluate(() => window.mono.getSnapshot());
      await page.evaluate(() => { document.getElementById('scroll-container').scrollTop = 6; });
      await page.waitForFunction((y) => Math.abs(window.mono.getSnapshot().position.y - (y - 6)) < 1, nested.position.y);
      assert.deepEqual(await page.evaluate(() => window.mono.getSnapshot().support), nested.support);
      await page.evaluate(() => { document.getElementById('scroll-container').scrollTop = 0; });
      await page.waitForFunction((y) => Math.abs(window.mono.getSnapshot().position.y - y) < 1, nested.position.y);
      profile.checks.nestedScrollAnchor = 'passed';
      await screenshot('structure');

      const runtime = await page.evaluate(async () => {
        const frames = [], scans = [];
        for (let i = 0; i < 120; i++) {
          await new Promise(requestAnimationFrame);
          const s = window.mono.getSnapshot();
          frames.push(s.diagnostics.frameMs);
          scans.push(s.diagnostics.scanMs);
        }
        const percentile = (values, fraction) => values.sort((a, b) => a - b)[Math.floor((values.length - 1) * fraction)];
        return { frameP50: percentile(frames, 0.5), frameP95: percentile(frames, 0.95), scanP95: percentile(scans, 0.95), surfaceCount: window.mono.getSnapshot().diagnostics.surfaceCount };
      });
      profile.runtimeSample = runtime;
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      profile.checks.horizontalOverflow = false;
      await page.locator('#destroy').click();
      assert.equal(await page.locator('canvas[data-mono-stickfigure]').count(), 0);
      await page.locator('#restart').click();
      await page.evaluate(() => window.demoReady);
      await settled();
      assert.equal(await page.locator('canvas[data-mono-stickfigure]').count(), 1);
      profile.checks.destroyRestart = 'passed';
      await page.evaluate(() => scrollTo({ top: 0, behavior: 'instant' }));
      if (viewport.width === 1440) {
        const session = await context.newCDPSession(page);
        await session.send('Emulation.setDeviceMetricsOverride', { width: 720, height: 500, deviceScaleFactor: 2, mobile: false, scale: 2 });
        await page.waitForFunction(() => innerWidth === 720);
        await screenshot('200-percent-top');
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
        await session.send('Emulation.clearDeviceMetricsOverride');
        profile.checks.layout200Percent = 'passed';
      }
      assert.deepEqual(errors, []);
      profile.status = 'passed';
      console.log(JSON.stringify({ run, width: viewport.width, status: profile.status, actions: profile.actions.length, checks: profile.checks }));
    } catch (error) {
      profile.status = 'failed';
      profile.failure = error instanceof Error ? error.message : String(error);
      if (!page.isClosed()) {
        profile.failureState = await page.evaluate(() => {
          const { surfaces, ...state } = window.mono.getSnapshot();
          return { ...state, scrollY, visibility: document.visibilityState };
        }).catch(() => null);
      }
      await screenshot('failure').catch(() => {});
      throw error;
    } finally {
      closing = true;
      await context.close();
      await writeFile(new URL('report.json', output), JSON.stringify(report, null, 2));
    }
  }
  await writeFile(new URL('../demo-verification.json', output), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser.close();
}
