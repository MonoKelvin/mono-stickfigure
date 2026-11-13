import { describe, expect, it } from 'vitest';
import { FixedStepClock } from '../../src/runtime/scheduler';

describe('固定步长', () => {
  it('不同刷新率推进相同模拟时间', () => {
    for (const hz of [30, 60, 120, 144]) {
      const clock = new FixedStepClock();
      let time = 0;
      for (let i = 0; i <= hz; i++) clock.advance(i * 1000 / hz, (dt) => { time += dt; });
      expect(time).toBeCloseTo(1, 8);
    }
  });

  it('迟帧不无界补算，恢复重置时钟', () => {
    const clock = new FixedStepClock();
    let count = 0;
    clock.advance(0, () => { count++; });
    clock.advance(60_000, () => { count++; });
    expect(count).toBe(6);
    expect(clock.droppedTimeMs).toBeCloseTo(59_950);
    clock.reset();
    clock.advance(120_000, () => { count++; });
    expect(count).toBe(6);
  });

  it('倒退时间戳不推进模拟', () => {
    const clock = new FixedStepClock();
    let count = 0;
    clock.advance(100, () => { count++; });
    clock.advance(50, () => { count++; });
    expect(count).toBe(0);
  });
});
