import { describe, expect, it } from 'vitest';
import { solveTwoBone } from '../../src/animation/ik';
import { BONES, createPose, IN_PLACE_CADENCE, JOINT, ROLL_DURATION, samplePose, SIT_STAND_DURATION } from '../../src/animation/rig';
import { FOOT_HEEL_LENGTH, FOOT_TOE_LENGTH } from '../../src/animation/geometry';
import { captureClimbAttachment, stepClimbAttachment } from '../../src/animation/climb';
import type { ClimbAttachmentSample } from '../../src/animation/climb';
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

describe('人体翻滚与新增姿态', () => {
  const h = 24;
  const point = (pose: ReturnType<typeof createPose>, id: number) => ({ x: pose.joints[id * 2]!, y: pose.joints[id * 2 + 1]! });
  const sample = (action: ActionId, time: number, facing: 1 | -1 = 1) => {
    const pose = createPose();
    samplePose(pose, { height: h, action, time, dt: 1, facing, verticalVelocity: 0, landProgress: 0, actionDuration: ROLL_DURATION,
      climb: { normal: { x: -facing * Math.cos(0.15), y: Math.sin(0.15) }, distance: time * h * 0.38 } });
    return pose;
  };

  it('新增动作和翻滚每个阶段保持全部骨长，左右朝向只镜像一次', () => {
    const lengths = [0.12, 0.065, 0.22, 0.19, 0.18, 0.19, 0.18, 0.255, 0.255, 0.255, 0.255];
    for (const action of ['sit', 'question', 'run-in-place', 'climb', 'roll'] as const) {
      for (let frame = 0; frame <= 100; frame++) {
        const right = sample(action, frame * ROLL_DURATION / 100);
        const left = sample(action, frame * ROLL_DURATION / 100, -1);
        for (const [index, bone] of BONES.entries()) {
          expect(distance(point(right, bone[0]), point(right, bone[1])), `${action} ${frame} ${index}`).toBeCloseTo(h * lengths[index]!, 7);
        }
        for (let i = 0; i < right.joints.length; i += 2) {
          expect(left.joints[i], `${action} ${frame}`).toBeCloseTo(-right.joints[i]!, 7);
          expect(left.joints[i + 1], `${action} ${frame}`).toBeCloseTo(right.joints[i + 1]!, 7);
        }
        expect([...right.joints].every(Number.isFinite)).toBe(true);
      }
    }
  });

  it('坐姿臀部、后撑双手和不对称双脚跟接地，起身保持脚跟接触', () => {
    for (const facing of [1, -1] as const) {
      const pose = sample('sit', 1, facing);
      expect(point(pose, JOINT.pelvis).y).toBeCloseTo(0, 5);
      for (const hand of [JOINT.leftHand, JOINT.rightHand]) {
        expect(point(pose, hand).y).toBeCloseTo(0, 5);
        expect(point(pose, hand).x * facing).toBeLessThan(point(pose, JOINT.pelvis).x * facing);
      }
      for (const [index, foot] of [JOINT.leftFoot, JOINT.rightFoot].entries()) {
        expect(point(pose, foot).y - Math.sin(pose.footAngles[index]!) * h * FOOT_HEEL_LENGTH).toBeCloseTo(0, 5);
      }
      expect(Math.abs(point(pose, JOINT.leftFoot).x - point(pose, JOINT.rightFoot).x)).toBeGreaterThan(h * 0.1);
      const seatedHead = point(pose, JOINT.head).y;
      for (let frame = 0; frame <= 63; frame++) samplePose(pose, { height: h, action: 'stand-up', time: frame * SIT_STAND_DURATION / 63, dt: 1 / 120, facing, verticalVelocity: 0, landProgress: 0, actionDuration: SIT_STAND_DURATION });
      expect(pose.sit).toBe(0);
      expect(point(pose, JOINT.head).y).toBeLessThan(seatedHead - h * 0.3);
    }
  });

  it('疑问只用一只手上下揉头，站立脚和另一只手保持稳定', () => {
    const a = sample('question', 0.15);
    const b = sample('question', 0.55);
    expect(Math.abs(point(a, JOINT.rightHand).y - point(b, JOINT.rightHand).y)).toBeGreaterThan(h * 0.04);
    for (const pose of [a, b]) {
      expect(distance(point(pose, JOINT.rightHand), point(pose, JOINT.head))).toBeLessThan(h * 0.1);
      expect(point(pose, JOINT.leftFoot).y).toBeCloseTo(0, 7);
      expect(point(pose, JOINT.rightFoot).y).toBeCloseTo(0, 7);
    }
    expect(point(a, JOINT.leftHand)).toEqual(point(b, JOINT.leftHand));
  });

  it('原地跑按时间抬腿摆肘，不制造平台行程', () => {
    const pose = createPose();
    const ankles: number[][] = [];
    const elbows: number[] = [];
    const leftElbowPhase: number[] = [];
    for (let frame = 0; frame < 120; frame++) {
      samplePose(pose, { height: h, action: 'run-in-place', time: frame / 120, dt: 1 / 120, facing: 1, verticalVelocity: 0, landProgress: 0, distance: 0, horizontalSpeed: 0 });
      if (frame > 40) { ankles.push([point(pose, JOINT.leftFoot).y, point(pose, JOINT.rightFoot).y]); elbows.push(point(pose, JOINT.leftElbow).x); leftElbowPhase.push(point(pose, JOINT.leftElbow).x - point(pose, JOINT.rightElbow).x); }
      expect(pose.distance).toBe(0);
      expect(pose.phase).toBe(0);
    }
    expect(ankles.some(([left, right]) => left! < -h * 0.2 && Math.abs(right!) < 1e-6)).toBe(true);
    expect(ankles.some(([left, right]) => right! < -h * 0.2 && Math.abs(left!) < 1e-6)).toBe(true);
    expect(Math.max(...elbows) - Math.min(...elbows)).toBeGreaterThan(h * 0.1);
    expect(Math.max(...leftElbowPhase) * Math.min(...leftElbowPhase)).toBeLessThan(0);
  });

  it('原地跑节奏约为每秒 1.2 个完整周期且左右手肘反相', () => {
    const pose = createPose();
    const sample = (time: number) => {
      samplePose(pose, { height: h, action: 'run-in-place', time, dt: 1 / 120, facing: 1, verticalVelocity: 0, landProgress: 0, distance: 0, horizontalSpeed: 0 });
      return { phase: pose.inPlacePhase, elbow: point(pose, JOINT.leftElbow).x, opposite: point(pose, JOINT.rightElbow).x };
    };
    sample(0);
    let previous = sample(1 / 120);
    let crossings = 0;
    let leftLift = 0;
    for (let frame = 2; frame <= 240; frame++) {
      const current = sample(frame / 120);
      if (Math.sign(current.elbow - current.opposite) !== Math.sign(previous.elbow - previous.opposite)) crossings++;
      if (point(pose, JOINT.leftFoot).y < -h * 0.2) leftLift++;
      previous = current;
    }
    expect(crossings).toBeGreaterThanOrEqual(4);
    expect(crossings).toBeLessThanOrEqual(6);
    expect(leftLift).toBeGreaterThan(0);
    expect(IN_PLACE_CADENCE).toBe(1.2);
  });

  const attachment = (overrides: Partial<ClimbAttachmentSample> = {}): ClimbAttachmentSample => ({ generation: 1, angle: 0, gather: 1, leftFoot: 1, rightFoot: 1, ready: true, failed: false, ...overrides });
  const climbingPose = (sample: ClimbAttachmentSample, distance = 0, speed = h * 0.4) => {
    const pose = createPose();
    samplePose(pose, { height: h, action: 'climb', time: 1, dt: 1, facing: 1, verticalVelocity: 0, landProgress: 0, climb: { normal: { x: -1, y: 0 }, distance, attachment: sample, speed } });
    return pose;
  };
  const footPoints = (pose: ReturnType<typeof createPose>, index: number) => {
    const foot = index === 0 ? JOINT.leftFoot : JOINT.rightFoot;
    const x = point(pose, foot).x, y = point(pose, foot).y, angle = pose.footAngles[index]!;
    const dx = pose.facingScale * Math.cos(angle) * h, dy = Math.sin(angle) * h;
    return { toe: { x: x + dx * FOOT_TOE_LENGTH, y: y + dy * FOOT_TOE_LENGTH }, heel: { x: x - dx * FOOT_HEEL_LENGTH, y: y - dy * FOOT_HEEL_LENGTH } };
  };

  it('悬挂初期下半身偏离心侧，随 gather 摆近墙并依次贴上脚尖', () => {
    const hanging = climbingPose(attachment({ angle: 0.3, gather: 0, leftFoot: 0, rightFoot: 0 }));
    const first = climbingPose(attachment({ angle: 0.06, gather: 0.6, leftFoot: 1, rightFoot: 0 }));
    const braced = climbingPose(attachment());
    expect(footPoints(first, 0).toe.x).toBeGreaterThan(footPoints(hanging, 0).toe.x + h * 0.05);
    expect(footPoints(hanging, 0).toe.x).toBeLessThan(h * 0.18);
    expect(footPoints(first, 0).toe.x).toBeCloseTo(h * 0.26, 4);
    expect(footPoints(first, 1).toe.x).toBeLessThan(h * 0.18);
    expect(footPoints(braced, 1).toe.x).toBeCloseTo(h * 0.26, 4);
  });

  it('稳态攀爬以脚尖顶墙，脚跟与膝盖留在墙外', () => {
    for (const facing of [1, -1] as const) {
      const pose = createPose();
      const wallX = 0.26 * h;
      samplePose(pose, { height: h, action: 'climb', time: 1, dt: 1, facing, verticalVelocity: 0, landProgress: 0, climb: { normal: { x: facing === 1 ? -1 : 1, y: 0 }, distance: 0, attachment: attachment(), speed: 0 } });
      for (const index of [0, 1]) {
        const { toe, heel } = footPoints(pose, index);
        expect(toe.x * facing).toBeCloseTo(wallX, 4);
        expect(heel.x * facing).toBeLessThan(wallX - h * 0.03);
      }
      for (const knee of [JOINT.leftKnee, JOINT.rightKnee]) expect(point(pose, knee).x * facing).toBeLessThan(wallX - h * 0.02);
      for (const [knee, foot] of [[JOINT.leftKnee, JOINT.leftFoot], [JOINT.rightKnee, JOINT.rightFoot]] as const) {
        expect(distance(point(pose, JOINT.pelvis), point(pose, knee))).toBeCloseTo(h * 0.255, 7);
        expect(distance(point(pose, knee), point(pose, foot))).toBeCloseTo(h * 0.255, 7);
      }
    }
  });

  it('攀爬每个相位只有一个肢体在移动，支撑脚尖世界位置不滑动', () => {
    const wallX = 0.26 * h;
    for (const phase of [0.125, 0.375, 0.625, 0.875]) {
      const pose = climbingPose(attachment(), phase * h * 0.4);
      const handCount = [JOINT.leftHand, JOINT.rightHand].filter(id => Math.abs(point(pose, id).x - wallX) < h * 0.01).length;
      const toeCount = [0, 1].filter(index => Math.abs(footPoints(pose, index).toe.x - wallX) < h * 0.01).length;
      expect(handCount + toeCount).toBe(3);
    }
    const aDistance = h * 0.02, bDistance = h * 0.08;
    const rootA = climbingPose(attachment(), aDistance);
    const rootB = climbingPose(attachment(), bDistance);
    const a = footPoints(rootA, 0).toe, b = footPoints(rootB, 0).toe;
    expect(a.x).toBeCloseTo(b.x, 5);
    expect(a.y - aDistance).toBeCloseTo(b.y - bDistance, 5);
  });

  it('从跳跃进入抓附的首帧锁住双手，不因全身融合而滑离墙面', () => {
    const pose = createPose();
    samplePose(pose, { height: h, action: 'jump', time: 0.15, dt: 1, facing: 1, verticalVelocity: -100, landProgress: 0, reach: { normal: { x: -1, y: 0 }, distance: h * 0.26, progress: 1 } });
    samplePose(pose, { height: h, action: 'climb', time: 0, dt: 1 / 60, facing: 1, verticalVelocity: 0, landProgress: 0, climb: { normal: { x: -1, y: 0 }, distance: 0, attachment: attachment({ angle: 0.28, gather: 0, leftFoot: 0, rightFoot: 0, ready: false }) } });
    for (const hand of [JOINT.leftHand, JOINT.rightHand]) expect(point(pose, hand).x).toBeCloseTo(h * 0.26, 5);
    for (const foot of [JOINT.leftFoot, JOINT.rightFoot]) expect(footPoints(pose, foot === JOINT.leftFoot ? 0 : 1).toe.x).toBeLessThan(h * 0.26 - h * 0.05);
  });

  it('攀爬每次只移动一个肢体，其余三个抓点留在墙面', () => {
    for (const phase of [0.1, 0.35, 0.6, 0.85]) {
      const pose = createPose();
      samplePose(pose, { height: h, action: 'climb', time: 1, dt: 1, facing: 1, verticalVelocity: 0, landProgress: 0, climb: { normal: { x: -1, y: 0 }, distance: phase * h * 0.4, attachment: attachment(), speed: h * 0.4 } });
      const hands = [JOINT.leftHand, JOINT.rightHand].filter(id => Math.abs(point(pose, id).x - h * 0.26) < h * 0.01).length;
      const toes = [0, 1].filter(index => Math.abs(footPoints(pose, index).toe.x - h * 0.26) < h * 0.01).length;
      expect(hands + toes).toBe(3);
    }
  });

  it('靠墙的空中阶段先伸双手，不拉伸手臂去追不可达抓点', () => {
    const pose = createPose();
    samplePose(pose, { height: h, action: 'jump', time: 0.15, dt: 1, facing: 1, verticalVelocity: -100, landProgress: 0, reach: { normal: { x: -1, y: 0 }, distance: h * 0.6, progress: 1 } });
    for (const [elbow, hand] of [[JOINT.leftElbow, JOINT.leftHand], [JOINT.rightElbow, JOINT.rightHand]] as const) {
      expect(point(pose, hand).x).toBeGreaterThan(point(pose, JOINT.chest).x);
      expect(distance(point(pose, JOINT.chest), point(pose, elbow))).toBeCloseTo(h * 0.19, 6);
      expect(distance(point(pose, elbow), point(pose, hand))).toBeCloseTo(h * 0.18, 6);
    }
  });

  it('攀爬抓点落在真实法向定义的边段上，支撑脚不随根沿边移动而滑动', () => {
    for (const angle of [0, 0.15, -0.15]) {
      const normal = { x: -Math.cos(angle), y: Math.sin(angle) };
      const tangent = { x: -normal.y, y: normal.x };
      const samples = [h * 0.02, h * 0.08].map((d) => {
        const pose = createPose();
        samplePose(pose, { height: h, action: 'climb', time: 1, dt: 1, facing: 1, verticalVelocity: 0, landProgress: 0, climb: { normal, distance: d } });
        const foot = footPoints(pose, 0).toe;
        const root = { x: normal.x * h * 0.26 + tangent.x * d, y: normal.y * h * 0.26 + tangent.y * d };
        const planted = { x: root.x + foot.x, y: root.y + foot.y };
        expect(planted.x * normal.x + planted.y * normal.y).toBeCloseTo(0, 5);
        return planted;
      });
      expect(samples[0]!.x).toBeCloseTo(samples[1]!.x, 5);
      expect(samples[0]!.y).toBeCloseTo(samples[1]!.y, 5);
    }
  });

  it('抓附完整时序的膝分支连续，不在贴脚时突然反折', () => {
    for (const slope of [-0.17, 0, 0.17]) for (const velocity of [{ x: 60, y: 200 }, { x: 0, y: 0 }]) {
      const normal = { x: -Math.cos(slope), y: Math.sin(slope) };
      const pose = createPose();
      let state = captureClimbAttachment(1, velocity, normal, h, 980);
      let previous: { x: number; y: number }[] | null = null;
      for (let frame = 0; frame <= 108; frame++) {
        samplePose(pose, { height: h, action: 'climb', time: frame / 120, dt: 1 / 120, facing: 1, verticalVelocity: 0, landProgress: 0, climb: { normal, distance: 0, attachment: state, speed: 0 } });
        const knees = [point(pose, JOINT.leftKnee), point(pose, JOINT.rightKnee)];
        if (previous) for (const index of [0, 1]) expect(distance(knees[index]!, previous[index]!), `${slope} ${frame}`).toBeLessThan(h * 0.10);
        previous = knees;
        state = stepClimbAttachment(state, 1 / 120, normal, h, 980);
      }
    }
  });

  it('两坡向和镜像抓附的实际脚尖脚跟不穿墙，ready 时确实可达', () => {
    for (const facing of [1, -1] as const) for (const slope of [-0.17, 0, 0.17]) for (const gravity of [400, 2000]) {
      const normal = { x: -facing * Math.cos(slope), y: Math.sin(slope) };
      for (const velocity of [{ x: 60 * facing, y: -200 }, { x: -2048 * facing, y: 600 }, { x: 0, y: 0 }]) {
        const pose = createPose();
        samplePose(pose, { height: h, action: 'idle', time: 0, dt: 1, facing, verticalVelocity: 0, landProgress: 0 });
        let state = captureClimbAttachment(1, velocity, normal, h, gravity);
        for (let frame = 0; frame <= 108; frame++) {
          samplePose(pose, { height: h, action: 'climb', time: frame / 120, dt: 1 / 120, facing, verticalVelocity: 0, landProgress: 0, climb: { normal, distance: 0, attachment: state, speed: 0 } });
          for (const index of [0, 1]) {
            const { toe, heel } = footPoints(pose, index);
            const gap = (p: typeof toe) => p.x * normal.x + p.y * normal.y + h * 0.26;
            expect(gap(toe), `${facing} ${slope} ${gravity} ${frame} toe${index}`).toBeGreaterThanOrEqual(-h * 1e-6);
            expect(gap(heel), `${facing} ${slope} ${gravity} ${frame} heel${index}`).toBeGreaterThanOrEqual(-h * 1e-6);
            if (state.ready) expect(gap(toe)).toBeCloseTo(0, 5);
          }
          state = stepClimbAttachment(state, 1 / 120, normal, h, gravity);
        }
        expect(state.ready).toBe(true);
      }
    }
  });

  it('双腕从斜墙抓附首帧到就绪始终到达目标而非仅保持骨长', () => {
    for (const facing of [1, -1] as const) for (const slope of [-0.17, 0, 0.17]) {
      const normal = { x: -facing * Math.cos(slope), y: Math.sin(slope) };
      const pose = createPose();
      samplePose(pose, { height: h, action: 'jump', time: 0.15, dt: 1, facing, verticalVelocity: -100, landProgress: 0, reach: { normal, distance: h * 0.26, progress: 1 } });
      let state = captureClimbAttachment(1, { x: 60 * facing, y: 200 }, normal, h, 980);
      for (let frame = 0; frame <= 108; frame++) {
        samplePose(pose, { height: h, action: 'climb', time: frame / 120, dt: 1 / 120, facing, verticalVelocity: 0, landProgress: 0, climb: { normal, distance: 0, attachment: state, speed: 0 } });
        for (const [index, hand] of [JOINT.leftHand, JOINT.rightHand].entries()) {
          const offset = index === 0 ? 0.70 : 0.50;
          const target = { x: (-normal.x * 0.26 - normal.y * offset * facing) * h, y: (-normal.y * 0.26 + normal.x * offset * facing) * h };
          expect(distance(point(pose, hand), target), `${facing} ${slope} ${frame}`).toBeLessThan(h * 1e-6);
        }
        state = stepClimbAttachment(state, 1 / 120, normal, h, 980);
      }
    }
  });

  it('坐起收脚时膝盖不穿平台，脚跟和双掌支撑不被骨长检查漏掉', () => {
    for (const facing of [1, -1] as const) {
      const pose = sample('sit', 1, facing);
      for (let frame = 0; frame <= 126; frame++) {
        const time = frame / 120;
        samplePose(pose, { height: h, action: 'stand-up', time, dt: 1 / 120, facing, verticalVelocity: 0, landProgress: 0, actionDuration: SIT_STAND_DURATION });
        for (const [knee, foot] of [[JOINT.leftKnee, JOINT.leftFoot], [JOINT.rightKnee, JOINT.rightFoot]] as const) {
          expect(point(pose, knee).y, `${facing} ${frame}`).toBeLessThanOrEqual(h * 1e-6);
          expect(distance(point(pose, JOINT.pelvis), point(pose, knee))).toBeCloseTo(h * 0.255, 7);
          expect(distance(point(pose, knee), point(pose, foot))).toBeCloseTo(h * 0.255, 7);
        }
        const heels = [0, 1].map(index => footPoints(pose, index).heel.y);
        expect(Math.max(...heels)).toBeCloseTo(0, 6);
        if (time < SIT_STAND_DURATION * 0.52) for (const hand of [JOINT.leftHand, JOINT.rightHand]) expect(point(pose, hand).y).toBeCloseTo(0, 6);
      }
    }
  });

  it('斜墙完整攀爬周期有三点支撑，实际脚尖世界抓点连续且停止后贴稳', () => {
    for (const facing of [1, -1] as const) for (const slope of [-0.17, 0, 0.17]) {
      const normal = { x: -facing * Math.cos(slope), y: Math.sin(slope) };
      const tangent = { x: -normal.y * facing, y: normal.x * facing };
      const pose = createPose();
      samplePose(pose, { height: h, action: 'idle', time: 0, dt: 1, facing, verticalVelocity: 0, landProgress: 0 });
      let previous: { x: number; y: number }[] | null = null;
      let previousPlanted: boolean[] = [];
      for (let frame = 0; frame <= 1000; frame++) {
        const d = frame * h * 0.4 / 1000;
        samplePose(pose, { height: h, action: 'climb', time: 1, dt: frame === 0 ? 1 : 1 / 120, facing, verticalVelocity: 0, landProgress: 0, climb: { normal, distance: d, attachment: attachment(), speed: h * 0.4 } });
        const root = { x: normal.x * h * 0.26 + tangent.x * d, y: normal.y * h * 0.26 + tangent.y * d };
        const contacts = [point(pose, JOINT.leftHand), point(pose, JOINT.rightHand), footPoints(pose, 0).toe, footPoints(pose, 1).toe].map(p => ({ x: root.x + p.x, y: root.y + p.y }));
        const phases = [0, 0.5, 0.25, 0.75].map(offset => (frame / 1000 + offset) % 1);
        const planted = phases.map(q => q < 0.75);
        expect(planted.filter(Boolean)).toHaveLength(3);
        for (const [index, p] of contacts.entries()) {
          const gap = p.x * normal.x + p.y * normal.y;
          expect(gap).toBeGreaterThanOrEqual(-h * 1e-6);
          if (planted[index]) {
            expect(gap).toBeCloseTo(0, 5);
            if (previous && previousPlanted[index]) expect(distance(p, previous[index]!)).toBeLessThan(h * 1e-6);
          }
        }
        for (const index of [0, 1]) {
          const heel = footPoints(pose, index).heel;
          expect((root.x + heel.x) * normal.x + (root.y + heel.y) * normal.y).toBeGreaterThan(h * 0.1);
        }
        previous = contacts; previousPlanted = planted;
      }
      for (let frame = 0; frame < 120; frame++) samplePose(pose, { height: h, action: 'climb', time: 2, dt: 1 / 120, facing, verticalVelocity: 0, landProgress: 0, climb: { normal, distance: h * 0.4, attachment: attachment(), speed: 0 } });
      for (const index of [0, 1]) {
        const toe = footPoints(pose, index).toe;
        expect(toe.x * normal.x + toe.y * normal.y + h * 0.26).toBeCloseTo(0, 4);
      }
    }
  });

  it('原地高抬腿与对侧肘摆一致，落脚相位和暂停恢复连续', () => {
    for (const facing of [1, -1] as const) {
      const pose = createPose();
      samplePose(pose, { height: h, action: 'idle', time: 0, dt: 1, facing, verticalVelocity: 0, landProgress: 0 });
      let previous = [...pose.footAngles];
      let left = false, right = false;
      for (let frame = 0; frame < 360; frame++) {
        const input = { height: h, action: 'run-in-place' as const, time: frame / 120, dt: 1 / 120, facing, verticalVelocity: 0, landProgress: 0, distance: 0, horizontalSpeed: 0 };
        samplePose(pose, input);
        if (frame > 60) {
          for (const index of [0, 1]) expect(Math.abs(pose.footAngles[index]! - previous[index]!)).toBeLessThan(0.02);
          if (point(pose, JOINT.leftFoot).y < -h * 0.2) {
            expect(point(pose, JOINT.rightElbow).x * facing).toBeGreaterThan(point(pose, JOINT.leftElbow).x * facing + h * 0.1);
            expect(point(pose, JOINT.leftKnee).y).toBeLessThan(point(pose, JOINT.rightKnee).y);
            left = true;
          }
          if (point(pose, JOINT.rightFoot).y < -h * 0.2) {
            expect(point(pose, JOINT.leftElbow).x * facing).toBeGreaterThan(point(pose, JOINT.rightElbow).x * facing + h * 0.1);
            expect(point(pose, JOINT.rightKnee).y).toBeLessThan(point(pose, JOINT.leftKnee).y);
            right = true;
          }
        }
        previous = [...pose.footAngles];
        if (frame === 180) {
          const joints = [...pose.joints], phase = pose.inPlacePhase;
          samplePose(pose, { ...input, dt: 0 });
          expect([...pose.joints]).toEqual(joints);
          expect(pose.inPlacePhase).toBe(phase);
        }
      }
      expect(left && right).toBe(true);
      expect(pose.distance).toBe(0);
      expect(pose.phase).toBe(0);
    }
  });

  it('后撑先于臀落，坐稳呼吸不移动臀掌脚跟，短时坐姿从当前脚位起身', () => {
    for (const facing of [1, -1] as const) for (const seatedUntil of [0.1, 0.4, 1.8]) {
      const pose = createPose();
      samplePose(pose, { height: h, action: 'idle', time: 0, dt: 1, facing, verticalVelocity: 0, landProgress: 0 });
      let handsAt = Infinity, hipAt = Infinity;
      for (let frame = 0; frame <= seatedUntil * 120; frame++) {
        samplePose(pose, { height: h, action: 'sit', time: frame / 120, dt: 1 / 120, clock: frame / 120, facing, verticalVelocity: 0, landProgress: 0 });
        if (Math.abs(point(pose, JOINT.leftHand).y) < h * 1e-4 && Math.abs(point(pose, JOINT.rightHand).y) < h * 1e-4) handsAt = Math.min(handsAt, frame);
        if (Math.abs(point(pose, JOINT.pelvis).y) < h * 1e-4) hipAt = Math.min(hipAt, frame);
        for (const index of [0, 1]) expect(footPoints(pose, index).heel.y).toBeCloseTo(0, 6);
        if (frame > 150) {
          expect(point(pose, JOINT.pelvis).y).toBeCloseTo(0, 6);
          for (const hand of [JOINT.leftHand, JOINT.rightHand]) expect(point(pose, hand).y).toBeCloseTo(0, 6);
        }
      }
      if (seatedUntil > 1) {
        expect(handsAt).toBeLessThan(hipAt);
        expect(Math.abs(point(pose, JOINT.leftFoot).x - point(pose, JOINT.rightFoot).x)).toBeGreaterThan(h * 0.1);
      }
      const initial = [point(pose, JOINT.leftFoot), point(pose, JOINT.rightFoot)];
      samplePose(pose, { height: h, action: 'stand-up', time: 0, dt: 0, facing, verticalVelocity: 0, landProgress: 0, actionDuration: SIT_STAND_DURATION });
      for (const [index, foot] of [JOINT.leftFoot, JOINT.rightFoot].entries()) expect(distance(point(pose, foot), initial[index]!)).toBeLessThan(h * 1e-6);
      for (let frame = 1; frame <= 126; frame++) {
        samplePose(pose, { height: h, action: 'stand-up', time: frame / 120, dt: 1 / 120, facing, verticalVelocity: 0, landProgress: 0, actionDuration: SIT_STAND_DURATION });
        for (const knee of [JOINT.leftKnee, JOINT.rightKnee]) expect(point(pose, knee).y).toBeLessThanOrEqual(h * 1e-6);
        expect(Math.max(...[0, 1].map(index => footPoints(pose, index).heel.y))).toBeCloseTo(0, 6);
      }
    }
  });

  it('翻滚先撑手再由肩背承接，收腿不重叠，结束没有残余整圈旋转', () => {
    const brace = sample('roll', ROLL_DURATION * 0.16);
    expect(point(brace, JOINT.leftHand).y).toBeCloseTo(0, 7);
    expect(point(brace, JOINT.rightHand).y).toBeCloseTo(0, 7);
    const back = sample('roll', ROLL_DURATION * 0.50);
    expect(point(back, JOINT.chest).y).toBeCloseTo(0, 7);
    expect(distance(point(back, JOINT.leftFoot), point(back, JOINT.rightFoot))).toBeGreaterThan(h * 0.15);
    const pose = sample('roll', ROLL_DURATION);
    for (let frame = 0; frame < 90; frame++) samplePose(pose, { height: h, action: 'walk', time: frame / 120, dt: 1 / 120, facing: 1, verticalVelocity: 0, landProgress: 0, distance: frame * h / 120, horizontalSpeed: h });
    expect(pose.rollAngle).toBe(0);
    expect(pose.roll).toBeLessThan(1e-5);
    expect(point(pose, JOINT.head).y).toBeLessThan(-h * 0.8);
  });
});
