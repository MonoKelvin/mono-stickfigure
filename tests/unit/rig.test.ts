import { describe, expect, it } from 'vitest';
import { solveTwoBone } from '../../src/animation/ik';
import { createPose, JOINT, samplePose } from '../../src/animation/rig';
import type { ActionId } from '../../src/types';

const distance = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);

describe('两段 IK 与骨架', () => {
  it('保持两段骨长并到达目标', () => {
    const origin = { x: 0, y: 0 };
    const result = solveTwoBone(origin, { x: 6, y: 0 }, 5, 5);
    expect(distance(origin, result.joint)).toBeCloseTo(5);
    expect(distance(result.joint, result.end)).toBeCloseTo(5);
    expect(result.end).toEqual({ x: 6, y: 0 });
  });

  it('不可达和零距离不拉伸骨长或产生 NaN', () => {
    const origin = { x: 0, y: 0 };
    for (const target of [{ x: 50, y: 0 }, { x: 0, y: 0 }]) {
      const result = solveTwoBone(origin, target, 5, 5);
      expect(distance(origin, result.joint)).toBeCloseTo(5);
      expect(distance(result.joint, result.end)).toBeCloseTo(5);
    }
  });

  it('动作切换后接触脚仍在支撑线上', () => {
    const pose = createPose();
    const sample = (action: ActionId, time: number) => samplePose(pose, { height: 40, action, time, dt: 1 / 60, verticalVelocity: 0, landProgress: time / 0.3, facing: 1 });
    for (let i = 0; i < 30; i++) sample('jump', i / 60);
    sample('land-soft', 0);
    expect(pose.joints[JOINT.leftFoot * 2 + 1]).toBeCloseTo(0);
    expect(pose.joints[JOINT.rightFoot * 2 + 1]).toBeCloseTo(0);
    for (const action of ['idle', 'jump', 'fall', 'land-soft'] as const) {
      sample(action, 0.15);
      const point = (id: number) => ({ x: pose.joints[id * 2]!, y: pose.joints[id * 2 + 1]! });
      expect(distance(point(JOINT.pelvis), point(JOINT.leftKnee))).toBeCloseTo(40 * 0.255);
      expect(distance(point(JOINT.leftKnee), point(JOINT.leftFoot))).toBeCloseTo(40 * 0.255);
      expect([...pose.joints].every(Number.isFinite)).toBe(true);
    }
  });
});
