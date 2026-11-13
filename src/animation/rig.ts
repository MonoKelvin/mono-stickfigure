import type { ActionId } from '../types';
import { solveTwoBone } from './ik';

export const JOINT = {
  head: 0, neck: 1, chest: 2, pelvis: 3,
  leftElbow: 4, leftHand: 5, rightElbow: 6, rightHand: 7,
  leftKnee: 8, leftFoot: 9, rightKnee: 10, rightFoot: 11,
} as const;

export const BONES: readonly (readonly [number, number])[] = [
  [0, 1], [1, 2], [2, 3], [2, 4], [4, 5], [2, 6], [6, 7],
  [3, 8], [8, 9], [3, 10], [10, 11],
];

export interface Pose {
  joints: Float64Array;
  headRadius: number;
  compression: number;
  arm: number;
  tuck: number;
}

export interface PoseInput {
  height: number;
  action: ActionId;
  time: number;
  dt: number;
  verticalVelocity: number;
  landProgress: number;
  facing: 1 | -1;
}

export function createPose(): Pose {
  return { joints: new Float64Array(24), headRadius: 0, compression: 0, arm: 0.4, tuck: 0 };
}

export function samplePose(output: Pose, input: PoseInput): void {
  const h = input.height;
  const landing = input.action === 'land-soft';
  const jumping = input.action === 'jump';
  const falling = input.action === 'fall';
  const targetCompression = landing ? 0.15 * Math.sin(Math.PI * Math.min(1, input.landProgress)) : 0;
  const targetArm = jumping ? -2.0 : falling ? -1.2 : 0.4;
  const targetTuck = jumping ? 0.10 : falling ? 0.03 : 0;
  const blend = Math.min(1, 1 - Math.exp(-Math.max(0, input.dt) / 0.07));
  output.compression += (targetCompression - output.compression) * blend;
  output.arm += (targetArm - output.arm) * blend;
  output.tuck += (targetTuck - output.tuck) * blend;
  output.headRadius = h * 0.12;
  const put = (id: number, x: number, y: number) => {
    output.joints[id * 2] = x * input.facing;
    output.joints[id * 2 + 1] = y;
  };
  const hip = { x: 0, y: h * (-0.45 + output.compression) };
  const chest = { x: 0, y: hip.y - h * 0.22 };
  put(JOINT.pelvis, hip.x, hip.y);
  put(JOINT.chest, chest.x, chest.y);
  put(JOINT.neck, 0, chest.y - h * 0.07);
  put(JOINT.head, 0, chest.y - h * 0.20);
  for (const side of [-1, 1] as const) {
    const foot = { x: side * h * 0.13, y: jumping || falling ? -output.tuck * h : 0 };
    const leg = solveTwoBone(hip, foot, h * 0.255, h * 0.255, side);
    put(side === -1 ? JOINT.leftKnee : JOINT.rightKnee, leg.joint.x, leg.joint.y);
    put(side === -1 ? JOINT.leftFoot : JOINT.rightFoot, leg.end.x, leg.end.y);
    const angle = output.arm + (falling ? Math.sin(input.time * 8 + side) * 0.06 : 0);
    const elbow = { x: chest.x + side * Math.sin(angle + 0.35) * h * 0.19, y: chest.y + Math.cos(angle + 0.35) * h * 0.19 };
    const hand = { x: elbow.x + side * Math.sin(angle - 0.25) * h * 0.18, y: elbow.y + Math.cos(angle - 0.25) * h * 0.18 };
    put(side === -1 ? JOINT.leftElbow : JOINT.rightElbow, elbow.x, elbow.y);
    put(side === -1 ? JOINT.leftHand : JOINT.rightHand, hand.x, hand.y);
  }
}
