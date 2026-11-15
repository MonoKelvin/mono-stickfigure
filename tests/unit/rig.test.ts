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

  it('侧视两条腿同向弯曲且小腿不交叉，左右朝向只镜像一次', () => {
    const right = createPose();
    const left = createPose();
    const input = { height: 24, action: 'idle' as const, time: 0, dt: 1, verticalVelocity: 0, landProgress: 0 };
    samplePose(right, { ...input, facing: 1 });
    samplePose(left, { ...input, facing: -1 });
    const point = (id: number) => ({ x: right.joints[id * 2]!, y: right.joints[id * 2 + 1]! });
    const hip = point(JOINT.pelvis);
    for (const [kneeId, footId] of [[JOINT.leftKnee, JOINT.leftFoot], [JOINT.rightKnee, JOINT.rightFoot]]) {
      const knee = point(kneeId!);
      const foot = point(footId!);
      expect((foot.x - hip.x) * (knee.y - hip.y) - (foot.y - hip.y) * (knee.x - hip.x)).toBeLessThan(0);
    }
    const a = point(JOINT.leftKnee), b = point(JOINT.leftFoot), c = point(JOINT.rightKnee), d = point(JOINT.rightFoot);
    const cross = (p: typeof a, q: typeof a, r: typeof a) => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
    expect(cross(a, b, c) * cross(a, b, d) < 0 && cross(c, d, a) * cross(c, d, b) < 0).toBe(false);
    for (let i = 0; i < right.joints.length; i += 2) {
      expect(left.joints[i]).toBeCloseTo(-right.joints[i]!);
      expect(left.joints[i + 1]).toBeCloseTo(right.joints[i + 1]!);
    }
  });

  it('每个步态相位保持骨长和接触，支撑脚的世界位置不滑动', () => {
    const h = 24;
    const pose = createPose();
    const sample = (d: number) => samplePose(pose, { height: h, action: 'walk', time: 0, dt: 1, verticalVelocity: 0, landProgress: 0, facing: 1, distance: d, horizontalSpeed: 32 });
    sample(2);
    const planted = 2 + pose.joints[JOINT.leftFoot * 2]!;
    sample(3);
    expect(3 + pose.joints[JOINT.leftFoot * 2]!).toBeCloseTo(planted, 5);
    for (let i = 0; i < 100; i++) {
      sample(h * 0.62 * i / 100);
      const point = (id: number) => ({ x: pose.joints[id * 2]!, y: pose.joints[id * 2 + 1]! });
      for (const [knee, foot] of [[JOINT.leftKnee, JOINT.leftFoot], [JOINT.rightKnee, JOINT.rightFoot]]) {
        expect(distance(point(JOINT.pelvis), point(knee!))).toBeCloseTo(h * 0.255, 6);
        expect(distance(point(knee!), point(foot!))).toBeCloseTo(h * 0.255, 6);
      }
      expect(Math.max(point(JOINT.leftFoot).y, point(JOINT.rightFoot).y)).toBeCloseTo(0);
      expect([...pose.joints].every(Number.isFinite)).toBe(true);
    }
  });

  it('相同行进距离的步态不因时间改变，下降速度增加时逐渐伸腿', () => {
    const a = createPose(), b = createPose();
    const input = { height: 24, action: 'walk' as const, dt: 1, verticalVelocity: 0, landProgress: 0, facing: 1 as const, distance: 4, horizontalSpeed: 30 };
    samplePose(a, { ...input, time: 1 });
    samplePose(b, { ...input, time: 20 });
    expect([...a.joints]).toEqual([...b.joints]);
    samplePose(a, { ...input, action: 'fall', time: 0, verticalVelocity: 10 });
    const tucked = a.joints[JOINT.leftFoot * 2 + 1]!;
    samplePose(a, { ...input, action: 'fall', time: 0.4, verticalVelocity: 400 });
    expect(a.joints[JOINT.leftFoot * 2 + 1]!).toBeGreaterThan(tucked);
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

describe('形状与动作过渡', () => {
  const base = { height: 24, time: 0, dt: 1, verticalVelocity: 0, landProgress: 0, facing: 1 as const };
  const at = (pose: ReturnType<typeof createPose>, id: number) => ({ x: pose.joints[id * 2]!, y: pose.joints[id * 2 + 1]! });

  it('待机时手肘落在躯干后侧，前臂向前而不是肘部向前凸出', () => {
    const pose = createPose();
    samplePose(pose, { ...base, action: 'idle' });
    const chest = at(pose, JOINT.chest);
    for (const [elbowId, handId] of [[JOINT.leftElbow, JOINT.leftHand], [JOINT.rightElbow, JOINT.rightHand]] as const) {
      const elbow = at(pose, elbowId);
      const hand = at(pose, handId);
      expect(elbow.x).toBeLessThanOrEqual(chest.x + 24 * 0.01);
      expect(hand.x).toBeGreaterThan(elbow.x);
      expect(hand.y).toBeGreaterThan(elbow.y);
    }
  });

  it('站立时腿接近伸直，膝盖横向偏移很小', () => {
    const pose = createPose();
    samplePose(pose, { ...base, action: 'idle' });
    const hip = at(pose, JOINT.pelvis);
    const knee = at(pose, JOINT.leftKnee);
    const foot = at(pose, JOINT.leftFoot);
    const offset = Math.abs((foot.x - hip.x) * (knee.y - hip.y) - (foot.y - hip.y) * (knee.x - hip.x)) / distance(hip, foot);
    expect(offset).toBeLessThan(24 * 0.06);
    expect(Math.abs(hip.y)).toBeGreaterThan(24 * 0.48);
  });

  it('待机呼吸随全局时钟变化但不破坏骨长和脚部接触', () => {
    const a = createPose(), b = createPose();
    samplePose(a, { ...base, action: 'idle', clock: 0 });
    samplePose(b, { ...base, action: 'idle', clock: 0.8 });
    expect(at(a, JOINT.head).y).not.toBeCloseTo(at(b, JOINT.head).y, 3);
    for (const pose of [a, b]) {
      for (const [knee, foot] of [[JOINT.leftKnee, JOINT.leftFoot], [JOINT.rightKnee, JOINT.rightFoot]] as const) {
        expect(distance(at(pose, JOINT.pelvis), at(pose, knee))).toBeCloseTo(24 * 0.255, 6);
        expect(distance(at(pose, knee), at(pose, foot))).toBeCloseTo(24 * 0.255, 6);
      }
      expect(at(pose, JOINT.leftFoot).y).toBeCloseTo(0, 6);
    }
  });

  it('转身是连续缩放，不出现瞬间镜像', () => {
    const pose = createPose();
    samplePose(pose, { ...base, action: 'idle', dt: 1 / 60 });
    expect(pose.facingScale).toBe(1);
    samplePose(pose, { ...base, action: 'turn', dt: 1 / 60, facing: -1 });
    expect(pose.facingScale).toBeGreaterThan(0.5);
    let previous = pose.facingScale;
    let sawMiddle = false;
    for (let i = 0; i < 20; i++) {
      samplePose(pose, { ...base, action: 'idle', dt: 1 / 60, facing: -1 });
      expect(Math.abs(pose.facingScale - previous)).toBeLessThan(0.35);
      if (Math.abs(pose.facingScale) < 0.8) sawMiddle = true;
      previous = pose.facingScale;
    }
    expect(sawMiddle).toBe(true);
    expect(pose.facingScale).toBe(-1);
    expect([...pose.joints].every(Number.isFinite)).toBe(true);
  });

  it('动作切换有过渡进度，且过渡期间骨长仍由 IK 精确保证', () => {
    const pose = createPose();
    samplePose(pose, { ...base, action: 'idle', dt: 1 / 60 });
    samplePose(pose, { ...base, action: 'walk', dt: 1 / 60, horizontalSpeed: 30, distance: 1 });
    expect(pose.transition).toBeGreaterThan(0);
    expect(pose.transition).toBeLessThan(1);
    for (let i = 0; i < 9; i++) {
      samplePose(pose, { ...base, action: 'walk', dt: 1 / 60, horizontalSpeed: 30, distance: 1 + i });
      for (const [knee, foot] of [[JOINT.leftKnee, JOINT.leftFoot], [JOINT.rightKnee, JOINT.rightFoot]] as const) {
        expect(distance(at(pose, JOINT.pelvis), at(pose, knee))).toBeCloseTo(24 * 0.255, 6);
        expect(distance(at(pose, knee), at(pose, foot))).toBeCloseTo(24 * 0.255, 6);
      }
    }
    expect(pose.transition).toBe(1);
  });
});
