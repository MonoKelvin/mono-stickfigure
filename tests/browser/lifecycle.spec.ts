import { expect, test } from '@playwright/test';

test('连续创建销毁 100 次不残留帧任务、观察器和画布', async ({ page }) => {
  test.setTimeout(60_000);
  await page.goto('/examples/');
  await page.evaluate(() => window.demoReady);
  const result = await page.evaluate(async () => {
    window.mono.destroy();
    const activeFrames = new Set<number>();
    const activeMutations = new Set<MutationObserver>();
    const activeResizes = new Set<ResizeObserver>();
    const raf = window.requestAnimationFrame.bind(window);
    const cancel = window.cancelAnimationFrame.bind(window);
    window.requestAnimationFrame = (callback) => {
      const id = raf((time) => { activeFrames.delete(id); callback(time); });
      activeFrames.add(id);
      return id;
    };
    window.cancelAnimationFrame = (id) => { activeFrames.delete(id); cancel(id); };
    const NativeMutation = window.MutationObserver;
    const NativeResize = window.ResizeObserver;
    window.MutationObserver = class extends NativeMutation {
      override observe(target: Node, options?: MutationObserverInit) { activeMutations.add(this); super.observe(target, options); }
      override disconnect() { activeMutations.delete(this); super.disconnect(); }
    };
    window.ResizeObserver = class extends NativeResize {
      override observe(target: Element, options?: ResizeObserverOptions) { activeResizes.add(this); super.observe(target, options); }
      override disconnect() { activeResizes.delete(this); super.disconnect(); }
    };
    const entry = '/dist/index.mjs';
    const { createStickFigure } = await import(entry) as typeof import('../../src/index');
    for (let i = 0; i < 100; i++) {
      const actor = createStickFigure({ root: document, seed: i });
      await actor.start();
      actor.destroy();
    }
    return { frames: activeFrames.size, mutations: activeMutations.size, resizes: activeResizes.size, canvases: document.querySelectorAll('canvas[data-mono-stickfigure]').length };
  });
  expect(result).toEqual({ frames: 0, mutations: 0, resizes: 0, canvases: 0 });
});
