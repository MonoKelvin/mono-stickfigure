import { chromium } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';

const run = process.env.MONO_VERIFY_RUN ?? String(Date.now());
assert.match(run, /^[\w-]+$/);
const dir = `.artifacts/naturalness-${run}`;
await mkdir(dir, { recursive: true });
const browser = await chromium.launch({ channel: 'msedge', headless: false });
const report = { run, browser: browser.version(), node: process.version, profiles: [], note: '真实 example 按钮、16/24 CSS px 和完整录屏；连续帧用于视觉复核，不代表独立生物力学或手机真机验收。' };
try {
  for (const height of [16, 24]) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 2, reducedMotion: 'no-preference', recordVideo: { dir: `${dir}/video`, size: { width: 1440, height: 1000 } } });
    const page = await context.newPage();
    const errors = [];
    const profile = { height, actions: [], errors };
    report.profiles.push(profile);
    page.on('pageerror', error => errors.push(error.message));
    try {
      await page.goto('http://127.0.0.1:5173/examples/?mode=manual');
      await page.evaluate(() => window.demoReady);
      if (height !== 16) {
        await page.locator('#size').evaluate((el, value) => { el.value = String(value); el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); }, height);
        await page.evaluate(() => window.demoReady);
      }
      assert.equal(await page.evaluate(() => window.mono.getSnapshot().appearance.height), height);
      for (const id of ['demo-climb', 'demo-slope', 'sit', 'stand-up', 'run-in-place']) {
        if (id === 'sit' || id === 'run-in-place') {
          await page.locator('button[data-place="action-runway"]').click();
          await page.waitForFunction(() => window.mono.getSnapshot().support !== null && window.mono.getSnapshot().status === 'running');
        }
        await page.locator(`#${id}`).click();
        if (id.startsWith('demo-')) await page.waitForFunction(() => window.mono.getSnapshot().climb !== null);
        else await page.waitForFunction(action => window.mono.getSnapshot().action === action, id);
        const frames = [], samples = [];
        const began = Date.now();
        for (let i = 0; i < (id.startsWith('demo-') ? 26 : 14); i++) {
          if (id === 'sit' && i > 0 && Date.now() - began > 1000) break;
          const sample = await page.evaluate(() => {
            const s = window.mono.getSnapshot();
            const box = document.querySelector('canvas[data-mono-stickfigure]').getBoundingClientRect();
            return { action: s.action, position: s.position, climb: s.climb, pauses: s.pauses, x: box.x, y: box.y, width: box.width, height: box.height };
          });
          assert.deepEqual(sample.pauses, []);
          samples.push({ ms: Date.now() - began, ...sample });
          const png = await page.screenshot();
          frames.push(png.toString('base64'));
          await page.evaluate(() => new Promise(resolve => { const t = performance.now(); const step = now => now - t >= 75 ? resolve() : requestAnimationFrame(step); requestAnimationFrame(step); }));
        }
        const strip = await page.evaluate(async ({ frames, samples }) => {
          const cell = 220, columns = 7;
          const canvas = document.createElement('canvas'); canvas.width = columns * cell; canvas.height = Math.ceil(frames.length / columns) * (cell + 24);
          const ctx = canvas.getContext('2d'); ctx.fillStyle = '#eee'; ctx.fillRect(0, 0, canvas.width, canvas.height); ctx.imageSmoothingEnabled = false;
          for (let i = 0; i < frames.length; i++) {
            const image = new Image(); image.src = `data:image/png;base64,${frames[i]}`; await image.decode();
            const x = i % columns * cell, y = Math.floor(i / columns) * (cell + 24);
            const scale = image.width / innerWidth, sample = samples[i];
            ctx.drawImage(image, Math.max(0, sample.x - 8) * scale, Math.max(0, sample.y - 8) * scale, (sample.width + 16) * scale, (sample.height + 16) * scale, x, y, cell, cell);
            ctx.fillStyle = '#000'; ctx.font = '14px monospace'; ctx.fillText(`${sample.ms}ms ${sample.action}`, x + 6, y + cell + 17);
          }
          return canvas.toDataURL('image/png').split(',')[1];
        }, { frames, samples });
        await writeFile(`${dir}/${height}-${id}.png`, Buffer.from(strip, 'base64'));
        if (id === 'sit') {
          profile.actions.push({ id, message: '坐稳后从真实起身按钮继续', samples });
          continue;
        }
        await page.waitForFunction(() => document.getElementById('cancel-action').disabled && !document.getElementById('message').textContent.includes('正在出发'), undefined, { timeout: 60000 });
        const message = await page.locator('#message').textContent();
        assert.ok(message.includes('已完成'), message);
        profile.actions.push({ id, message, samples });
        console.log(`${height}px ${id}: ${message}`);
      }
      assert.deepEqual(errors, []);
      profile.completed = true;
    } finally {
      const video = page.video();
      await context.close();
      await video.saveAs(`${dir}/${height}px.webm`);
      await video.delete();
    }
  }
} finally {
  await writeFile(`${dir}/report.json`, JSON.stringify(report, null, 2));
  await browser.close();
}
