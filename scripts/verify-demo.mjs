import { chromium } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const output = new URL('../.artifacts/', import.meta.url);
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ channel: 'msedge', headless: false });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, reducedMotion: 'no-preference' });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('http://127.0.0.1:5173/examples/');
  await page.evaluate(() => window.demoReady);
  await page.waitForFunction(() => window.mono.getSnapshot().status === 'running');
  await page.screenshot({ path: fileURLToPath(new URL('desktop.png', output)) });
  const startY = await page.evaluate(() => window.mono.getSnapshot().position.y);
  await page.locator('#jump').click();
  await page.waitForFunction((y) => window.mono.getSnapshot().position.y < y - 18, startY);
  await page.screenshot({ path: fileURLToPath(new URL('jump.png', output)) });
  await page.waitForFunction(() => window.mono.getSnapshot().action === 'idle');
  await page.locator('#move').click();
  const startX = await page.evaluate(() => window.mono.getSnapshot().position.x);
  await page.waitForFunction((x) => Math.abs(window.mono.getSnapshot().position.x - x) > 12, startX);
  await page.locator('#hide-panel').click();
  await page.waitForFunction(() => window.mono.getSnapshot().action === 'idle' && window.mono.getSnapshot().support !== null);
  await page.locator('#place-button').click();
  await page.locator('#landing').click();
  if (await page.locator('#clicks').textContent() !== '1') throw new Error('宿主按钮点击未执行');
  const runtime = await page.evaluate(async () => {
    const frames = [];
    const scan = [];
    for (let i = 0; i < 180; i++) {
      await new Promise(requestAnimationFrame);
      const snapshot = window.mono.getSnapshot();
      frames.push(snapshot.diagnostics.frameMs);
      scan.push(snapshot.diagnostics.scanMs);
    }
    const percentile = (values, fraction) => values.sort((a, b) => a - b)[Math.floor((values.length - 1) * fraction)];
    return { frameP50: percentile(frames, 0.5), frameP95: percentile(frames, 0.95), scanP95: percentile(scan, 0.95), surfaceCount: window.mono.getSnapshot().diagnostics.surfaceCount };
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('#restart').click();
  await page.evaluate(() => window.demoReady);
  await page.screenshot({ path: fileURLToPath(new URL('mobile-layout.png', output)), fullPage: true });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
  if (overflow) throw new Error('移动布局出现水平溢出');
  if (errors.length) throw new Error(errors.join('\n'));
  const report = { browser: browser.version(), os: process.platform, runtime, consoleErrors: errors, mobileLayoutOverflow: overflow, note: '本机 Edge 实际操作；手机尺寸仅布局模拟，不代表真机验收。耗时为小型示例的初步采样。' };
  await writeFile(new URL('demo-verification.json', output), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser.close();
}
