import { describe, expect, it } from 'vitest';
import { captureClimbAttachment, CLIMB_ATTACH_DURATION, sampleClimbAttachment, stepClimbAttachment } from '../../src/animation/climb';
import type { ClimbAttachmentState } from '../../src/animation/climb';
import { FixedStepClock } from '../../src/runtime/scheduler';

const normal = { x: -1, y: 0 };
const height = 24;
const gravity = 980;
const capture = (velocity = { x: 60, y: 150 }, generation = 1) => captureClimbAttachment(generation, velocity, normal, height, gravity);

function advance(state: ClimbAttachmentState, steps: number, g = gravity, h = height, n = normal): ClimbAttachmentState {
  for (let i = 0; i < steps; i++) state = stepClimbAttachment(state, 1 / 120, n, h, g);
  return state;
}

describe('局部抓附惯性与顺序贴脚', () => {
  it('用抓前横纵速度播种角动量，镜像不会重复反转', () => {
    const rising = capture({ x: 60, y: -200 });
    const descending = capture({ x: 60, y: 200 });
    expect(rising.angularVelocity).toBeGreaterThan(descending.angularVelocity);
    expect(capture({ x: 20, y: 0 }).angularVelocity).not.toBe(capture({ x: 60, y: 0 }).angularVelocity);
    const mirrored = captureClimbAttachment(1, { x: -60, y: 150 }, { x: 1, y: 0 }, height, gravity);
    expect(mirrored).toEqual(capture());
    expect(advance(mirrored, 30, gravity, height, { x: 1, y: 0 })).toEqual(advance(capture(), 30));
  });

  it('摆动随重力和惯性变化，而不是静止悬腿与定时平移', () => {
    const initial = capture({ x: 20, y: 0 });
    const weak = advance(initial, 12, 400);
    const strong = advance(initial, 12, 2000);
    expect(Math.abs(weak.angle - strong.angle)).toBeGreaterThan(0.001);
    const driven = advance(capture(), 24);
    expect(driven.angle).toBeLessThan(initial.angle);
    expect(driven.leftFoot).toBe(0);
    expect(driven.rightFoot).toBe(0);
  });

  it('先收拢再依次贴脚，限时内就绪且不改写前一样本', () => {
    let state = capture();
    let singleFoot = false;
    for (let i = 0; i < 108; i++) {
      const before = { ...state };
      const next = stepClimbAttachment(state, 1 / 120, normal, height, gravity);
      expect(state).toEqual(before);
      expect(next.gather).toBeGreaterThanOrEqual(state.gather);
      expect(next.leftFoot).toBeGreaterThanOrEqual(state.leftFoot);
      expect(next.rightFoot).toBeGreaterThanOrEqual(state.rightFoot);
      if (next.leftFoot > 0 && next.rightFoot === 0) singleFoot = true;
      if (next.rightFoot > 0) expect(next.leftFoot).toBeCloseTo(1, 10);
      state = next;
    }
    expect(singleFoot).toBe(true);
    expect(state).toMatchObject({ time: CLIMB_ATTACH_DURATION, angle: 0, angularVelocity: 0, gather: 1, leftFoot: 1, rightFoot: 1, ready: true, failed: false });
    expect(stepClimbAttachment(state, 10, normal, height, gravity)).toEqual(state);
  });

  it('30/60/120/144 Hz 显示帧消费同一固定步轨迹', () => {
    const samples = [30, 60, 120, 144].map(fps => {
      const clock = new FixedStepClock();
      let state = capture();
      clock.advance(0, () => {});
      for (let frame = 1; frame <= fps / 2; frame++) {
        clock.advance(frame * 1000 / fps, dt => { state = stepClimbAttachment(state, dt, normal, height, gravity); });
      }
      return state;
    });
    for (const state of samples) expect(state).toEqual(samples[0]);
    expect(samples[0]!.time).toBeCloseTo(0.5, 12);
    expect(samples[0]!.ready).toBe(false);
  });

  it('插值只混合相同抓附代次，重抓不带回旧摆角', () => {
    const previous = capture();
    const current = advance(previous, 30);
    const sample = sampleClimbAttachment(previous, current, 0.25);
    expect(sample.angle).toBeCloseTo(previous.angle + (current.angle - previous.angle) * 0.25, 12);
    expect(sample.gather).toBeCloseTo(previous.gather + (current.gather - previous.gather) * 0.25, 12);
    const again = capture({ x: 0, y: -100 }, 2);
    expect(sampleClimbAttachment(current, again, 0)).toEqual(sampleClimbAttachment(null, again, 1));
    expect(sampleClimbAttachment(previous, current, -1)).toMatchObject({ angle: previous.angle, gather: previous.gather });
  });

  it('不消费暂停时间，恢复后仍从保留的数值状态收敛', () => {
    const paused = advance(capture(), 25);
    const preserved = { ...paused };
    const restored = advance(paused, 108 - 25);
    expect(paused).toEqual(preserved);
    expect(restored.ready).toBe(true);
    expect(restored.time).toBe(CLIMB_ATTACH_DURATION);
  });

  it('合理身高、重力、陡边和强入抓速度始终有限且有界', () => {
    for (const h of [12, 16, 40, 256]) for (const g of [400, 980, 2000]) for (const slope of [-0.15, 0, 0.15]) {
      const n = { x: -Math.cos(slope), y: Math.sin(slope) };
      for (const velocity of [{ x: -2048, y: -800 }, { x: 0, y: 0 }, { x: 2048, y: 600 }]) {
        let state = captureClimbAttachment(1, velocity, n, h, g);
        for (let step = 0; step < 108; step++) {
          state = stepClimbAttachment(state, 1 / 120, n, h, g);
          expect([state.angle, state.angularVelocity, state.gather, state.leftFoot, state.rightFoot, state.time].every(Number.isFinite)).toBe(true);
          expect(state.angle).toBeGreaterThan(-0.45);
          expect(state.angle).toBeLessThanOrEqual(0.62);
          expect(Math.abs(state.angularVelocity)).toBeLessThanOrEqual(8);
          expect(state.time).toBeLessThanOrEqual(CLIMB_ATTACH_DURATION);
        }
        expect(state.ready).toBe(true);
        expect(state.failed).toBe(false);
      }
    }
  });

  it('数值失效保持安全失败样本，不输出 NaN 或宣称贴脚就绪', () => {
    for (const state of [captureClimbAttachment(1, { x: NaN, y: 0 }, normal, height, gravity), captureClimbAttachment(1, { x: 0, y: 0 }, { x: 0, y: 0 }, height, gravity), captureClimbAttachment(1, { x: 0, y: 0 }, normal, 0, gravity)]) {
      expect(state.failed).toBe(true);
      expect(state.ready).toBe(false);
      expect(state.leftFoot).toBe(0);
      expect(state.rightFoot).toBe(0);
      expect(Number.isFinite(state.angle)).toBe(true);
    }
    const valid = capture();
    expect(stepClimbAttachment(valid, NaN, normal, height, gravity).failed).toBe(true);
    expect(valid.failed).toBe(false);
  });
});
