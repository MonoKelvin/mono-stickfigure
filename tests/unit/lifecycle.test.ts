import { describe, expect, it } from 'vitest';
import { createStickFigure, VERSION } from '../../src/index';
import { version } from '../../package.json';

describe('无 DOM 的入口与生命周期', () => {
  it('公共版本来自包元数据', () => {
    expect(VERSION).toBe(version);
  });

  it('连续重力保留原值，拒绝范围外与无效坠落限速', () => {
    for (const gravity of [4, 9.80125, 20]) {
      const actor = createStickFigure({ physics: { gravity, maxFallSpeed: 450 } });
      expect(actor.getSnapshot().physics.gravity).toBe(gravity);
      expect(actor.getSnapshot().physics.maxFallSpeed).toBe(450);
      actor.destroy();
    }
    for (const gravity of [3.999, 20.001, NaN, Infinity]) {
      expect(() => createStickFigure({ physics: { gravity } })).toThrow();
    }
    for (const maxFallSpeed of [0, -1, NaN, Infinity]) {
      expect(() => createStickFigure({ physics: { maxFallSpeed } })).toThrow();
    }
    expect(() => createStickFigure({ performance: { navigationBudgetMs: 0 } })).toThrow();
  });

  it('导入和创建不访问浏览器', () => {
    const actor = createStickFigure({ seed: 7 });
    expect(actor.getSnapshot().status).toBe('created');
    expect(actor.getSnapshot().position).toBeNull();
    actor.destroy();
    actor.destroy();
    expect(actor.getSnapshot().status).toBe('destroyed');
  });

  it('服务器启动明确失败且不留下 starting 状态', async () => {
    const actor = createStickFigure();
    await expect(actor.start()).rejects.toThrow('BROWSER_REQUIRED');
    expect(actor.getSnapshot().status).toBe('created');
    actor.destroy();
    await expect(actor.start()).rejects.toThrow('DESTROYED');
  });

  it('默认人物更小且重力不会随外观大小改变', () => {
    const small = createStickFigure({ appearance: { height: 16 } });
    const large = createStickFigure({ appearance: { height: 40 } });
    const defaults = createStickFigure();
    expect(defaults.getSnapshot().appearance.height).toBe(16);
    expect(defaults.getSnapshot().autonomous).toBe(true);
    expect(small.getSnapshot().physics).toEqual(large.getSnapshot().physics);
    expect(defaults.getSnapshot().physics).toEqual({ gravity: 9.8, jumpHeight: 52, maxFallSpeed: 600 });
    defaults.setAutonomous(false);
    expect(defaults.getSnapshot().autonomous).toBe(false);
    for (const actor of [small, large, defaults]) actor.destroy();
  });

  it('配置边界拒绝非有限值', () => {
    expect(() => createStickFigure({ physics: { gravity: 0 } })).toThrow();
    expect(() => createStickFigure({ physics: { jumpHeight: Infinity } })).toThrow();
    expect(() => createStickFigure({ appearance: { height: NaN } })).toThrow();
    expect(() => createStickFigure({ performance: { maxSurfaces: 1.5 } })).toThrow();
    expect(() => createStickFigure({ seed: Infinity })).toThrow();
  });

  it('未启动操作返回拒绝，不创建隐式实例', async () => {
    const actor = createStickFigure();
    expect(await actor.place({ surfaceId: 'missing' })).toEqual({ status: 'rejected', reason: 'not-started' });
    expect(await actor.requestAction('jump')).toEqual({ status: 'rejected', reason: 'not-running' });
    actor.pause();
    expect(actor.getSnapshot().pauses).toContain('user');
    actor.resume();
    expect(actor.getSnapshot().pauses).not.toContain('user');
  });
});
