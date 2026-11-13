import { chromium } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';

const output = new URL('../.artifacts/', import.meta.url);
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ channel: 'msedge', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, reducedMotion: 'no-preference' });
  await page.goto('http://127.0.0.1:5173/examples/');
  await page.evaluate(() => window.demoReady);
  const results = await page.evaluate(async () => {
    window.mono.destroy();
    const { createPose, samplePose } = await import('/src/animation/rig.ts');
    const { CanvasRenderer } = await import('/src/rendering/canvas.ts');
    const { createSvgReference } = await import('/tests/fixtures/svg-reference.ts');
    const modes = ['canvas', 'svg'];
    const results = [];
    for (const mode of modes) {
      const renderer = mode === 'canvas'
        ? new CanvasRenderer(document, document.body, { height: 36, color: '#2455d6', lineWidth: 2, head: 'circle' }, 2)
        : createSvgReference(document, document.body, 36, '#2455d6');
      if (mode === 'canvas') renderer.setVisible(true);
      const pose = createPose();
      const costs = [];
      const intervals = [];
      let last = 0;
      for (let frame = 0; frame < 210; frame++) {
        const timestamp = await new Promise(requestAnimationFrame);
        samplePose(pose, { height: 36, action: frame % 120 < 60 ? 'jump' : 'land-soft', time: frame / 60, dt: 1 / 60, verticalVelocity: 0, landProgress: (frame % 60) / 60, facing: 1 });
        const start = performance.now();
        renderer.draw({ x: 350 + Math.sin(frame / 60) * 20, y: 450 }, pose);
        if (frame >= 30) { costs.push(performance.now() - start); intervals.push(timestamp - last); }
        last = timestamp;
      }
      const percentile = (values, p) => values.sort((a, b) => a - b)[Math.floor((values.length - 1) * p)];
      results.push({ renderer: mode, drawP50: percentile(costs, 0.5), drawP95: percentile(costs, 0.95), frameIntervalP95: percentile(intervals, 0.95), nodes: renderer.element.querySelectorAll('*').length + 1 });
      renderer.destroy();
    }
    return results;
  });
  const report = { browser: browser.version(), results, note: '相同 Pose 的局部绘制对照，仅测 JS 调用耗时和帧间隔，不是 GPU/总内存基准，不据此宣称 Canvas 一定更快。' };
  await writeFile(new URL('renderer-benchmark.json', output), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser.close();
}
