import { describe, expect, it } from 'vitest';
import { createStickFigure } from '../../src/index';

describe('无 DOM 的入口与生命周期', () => {
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

  it('配置边界拒绝非有限值', () => {
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
