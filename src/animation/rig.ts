import type { ActionId } from '../types';
import type { Point } from '../scene/types';
import type { ClimbAttachmentSample } from './climb';
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

export const TURN_DURATION = 0.26;
export const LAND_DURATION = 0.24;
export const ROLL_DURATION = 0.92;
export const FOOT_HEEL_LENGTH = 0.035;
export const FOOT_TOE_LENGTH = 0.075;
export const SIT_DOWN_DURATION = 0.85;
export const SIT_STAND_DURATION = 1.05;
export const IN_PLACE_CADENCE = 1.2;
const CLIMB_STRIDE = 0.4;
const CLIMB_CHEST_GAP = 0.235;
export const STAND_DURATION = 0.48;
export const POSE_DURATION = { wave: 1.5, crouch: 1.5, rest: 3.2, prone: 2.6, sit: 3.2, question: 1.8, 'run-in-place': 2.4, climb: 2.4 } as const;
export const TRANSITION_DURATION = { anticipate: 0.16, brake: 0.14 } as const;

const clamp01 = (value: number): number => Math.max(0, Math.min(1, value));
const smoothstep = (value: number): number => value * value * (3 - 2 * value);
const mix = (from: number, to: number, amount: number): number => from + (to - from) * amount;
const mixAngle = (from: number, to: number, amount: number): number => from + Math.atan2(Math.sin(to - from), Math.cos(to - from)) * amount;
const hermite = (from: number, to: number, fromVelocity: number, toVelocity: number, t: number): number => (2 * t ** 3 - 3 * t ** 2 + 1) * from + (t ** 3 - 2 * t ** 2 + t) * fromVelocity + (-2 * t ** 3 + 3 * t ** 2) * to + (t ** 3 - t ** 2) * toVelocity;

interface GaitFoot {
  x: number;
  y: number;
  angle: number;
}

function gaitFoot(q: number, running: boolean, sprint: number, stride: number): GaitFoot {
  const cycle = running ? stride : 0.76;
  const stance = running ? mix(1.42 * 0.32, 1.8 * 0.28, sprint) / cycle : 0.62;
  const front = running ? mix(0.17, 0.18, sprint) : 0.20;
  const back = front - cycle * stance;
  const roll = running ? 1.04 : 0.72;
  const strike = running ? -0.10 : -0.28;
  if (q < stance) {
    const progress = q / stance;
    const angle = progress < 0.18 ? strike * (1 - smoothstep(progress / 0.18)) : roll * smoothstep(clamp01((progress - 0.65) / 0.35));
    const x = front - cycle * q + (angle > 0 ? 0.075 * (1 - Math.cos(angle)) : 0.035 * (Math.cos(angle) - 1));
    const y = angle > 0 ? -0.075 * Math.sin(angle) : 0.035 * Math.sin(angle);
    return { x, y, angle };
  }
  const t = (q - stance) / (1 - stance);
  const rear = back + 0.075 * (1 - Math.cos(roll));
  const lift = -0.075 * Math.sin(roll);
  const reach = front + 0.035 * (Math.cos(strike) - 1);
  const touch = 0.035 * Math.sin(strike);
  const first = running ? 0.28 : 0.45;
  const second = running ? 0.64 : 0.78;
  const passX = running ? -0.17 : -0.015;
  const passY = running ? -mix(0.29, 0.33, sprint) : -0.072;
  const forwardX = running ? mix(0.26, 0.30, sprint) : 0.23;
  const forwardY = running ? -0.075 : -0.025;
  const passingSpeed = running ? 0.85 : 0.72;
  const loweringSpeed = running ? 0.36 : 0.14;
  const retract = -cycle * (1 - stance);
  let x: number, y: number;
  if (t < first) {
    const u = t / first;
    x = hermite(rear, passX, retract * first, passingSpeed * first, u);
    y = hermite(lift, passY, 0, 0, u);
  } else if (t < second) {
    const span = second - first, u = (t - first) / span;
    x = hermite(passX, forwardX, passingSpeed * span, 0, u);
    y = hermite(passY, forwardY, 0, loweringSpeed * span, u);
  } else {
    const span = 1 - second, u = (t - second) / span;
    x = hermite(forwardX, reach, 0, retract * span, u);
    y = hermite(forwardY, touch, loweringSpeed * span, 0, u);
  }
  const angle = t < first ? mix(roll, running ? 0.18 : -0.08, smoothstep(t / first)) : mix(running ? 0.18 : -0.08, strike, smoothstep((t - first) / (1 - first)));
  return { x, y, angle };
}

interface RollFrame {
  at: number;
  hip: Point;
  lean: number;
  neck: number;
  head: number;
  feet: readonly [Point, Point];
  hands: readonly [Point, Point];
}

const ROLL_FRAMES: readonly RollFrame[] = [
  { at: 0, hip: { x: -0.04, y: -0.38 }, lean: 0.50, neck: 0.40, head: 0.30, feet: [{ x: -0.09, y: 0 }, { x: 0.10, y: 0 }], hands: [{ x: -0.17, y: -0.25 }, { x: 0.16, y: -0.26 }] },
  { at: 0.16, hip: { x: -0.12, y: -0.20 }, lean: 1.15, neck: 0.90, head: 0.70, feet: [{ x: -0.17, y: 0 }, { x: 0.07, y: 0 }], hands: [{ x: 0.25, y: 0 }, { x: 0.20, y: 0 }] },
  { at: 0.34, hip: { x: -0.12, y: -0.24 }, lean: 2.30, neck: 0.80, head: 0.35, feet: [{ x: -0.19, y: -0.08 }, { x: 0.16, y: -0.05 }], hands: [{ x: 0.25, y: 0 }, { x: 0.13, y: -0.01 }] },
  { at: 0.50, hip: { x: 0.02, y: -0.20 }, lean: 3.35, neck: 1.50, head: 0.40, feet: [{ x: 0.16, y: -0.44 }, { x: 0.29, y: -0.29 }], hands: [{ x: 0.15, y: -0.02 }, { x: 0.24, y: -0.08 }] },
  { at: 0.68, hip: { x: 0.07, y: -0.19 }, lean: 4.90, neck: 3.10, head: 1.10, feet: [{ x: 0.22, y: -0.20 }, { x: -0.16, y: -0.35 }], hands: [{ x: 0.15, y: -0.02 }, { x: 0.10, y: 0 }] },
  { at: 0.84, hip: { x: 0.08, y: -0.22 }, lean: 6.42, neck: 6.35, head: 6.28, feet: [{ x: 0.23, y: 0 }, { x: -0.12, y: -0.025 }], hands: [{ x: 0.15, y: -0.10 }, { x: -0.03, y: -0.16 }] },
  { at: 1, hip: { x: 0, y: -0.507 }, lean: Math.PI * 2, neck: Math.PI * 2, head: Math.PI * 2, feet: [{ x: -0.04, y: 0 }, { x: 0.04, y: 0 }], hands: [{ x: -0.03, y: -0.35 }, { x: 0.06, y: -0.34 }] },
];

function rollFrame(progress: number): RollFrame {
  const index = ROLL_FRAMES.findIndex((frame) => frame.at >= progress);
  const to = ROLL_FRAMES[Math.max(1, index)]!;
  const from = ROLL_FRAMES[Math.max(0, index - 1)]!;
  const amount = smoothstep(clamp01((progress - from.at) / (to.at - from.at)));
  const point = (a: Point, b: Point): Point => ({ x: mix(a.x, b.x, amount), y: mix(a.y, b.y, amount) });
  return { at: progress, hip: point(from.hip, to.hip), lean: mix(from.lean, to.lean, amount), neck: mix(from.neck, to.neck, amount), head: mix(from.head, to.head, amount),
    feet: [point(from.feet[0], to.feet[0]), point(from.feet[1], to.feet[1])], hands: [point(from.hands[0], to.hands[0]), point(from.hands[1], to.hands[1])] };
}

function climbPoint(normal: Point, offset: number, lift = 0): Point {
  return { x: normal.x * (lift - 0.26) - normal.y * offset, y: normal.y * (lift - 0.26) + normal.x * offset };
}

function climbGrip(normal: Point, phase: number, hand: boolean, movement = 1): Point {
  const q = ((phase % 1) + 1) % 1;
  const top = hand ? 0.70 : 0.30;
  if (q < 0.75) return climbPoint(normal, top - q * CLIMB_STRIDE);
  const u = (q - 0.75) / 0.25;
  return climbPoint(normal, mix(top - 0.75 * CLIMB_STRIDE, top, smoothstep(u)), Math.sin(Math.PI * u) * (hand ? 0.06 : 0.08) * movement);
}

export function transitionDuration(from: ActionId | null, to: ActionId): number {
  if (!from) return 0.001;
  if (to === 'roll' || from === 'roll') return 0.14;
  if (to === 'turn') return TURN_DURATION;
  if (to === 'stand-up' || from === 'prone' || to === 'prone' || from === 'sit' || to === 'sit') return STAND_DURATION;
  if (to === 'climb' || from === 'climb') return 0.12;
  if (to === 'crouch' || from === 'crouch') return 0.26;
  if (to === 'anticipate') return TRANSITION_DURATION.anticipate;
  if (to === 'brake') return TRANSITION_DURATION.brake;
  if (to === 'fall') return 0.09;
  if (to === 'land-soft') return 0.12;
  return 0.16;
}

export interface Pose {
  joints: Float64Array;
  footAngles: Float64Array;
  headRadius: number;
  compression: number;
  arm: number;
  bend: number;
  tuck: number;
  lean: number;
  hip: number;
  runMix: number;
  sprint: number;
  crouch: number;
  rest: number;
  prone: number;
  roll: number;
  rollProgress: number;
  rollAngle: number;
  airProgress: number;
  standProne: number;
  standCrouch: number;
  standSit: number;
  standLeftFoot: Point;
  standRightFoot: Point;
  standFootAngles: Float64Array;
  sit: number;
  question: number;
  inPlace: number;
  inPlacePhase: number;
  climbing: number;
  climbNormal: Point;
  climbDistance: number;
  climbAngle: number;
  climbGather: number;
  climbLeftFoot: number;
  climbRightFoot: number;
  climbMoving: number;
  airLead: 1 | -1;
  wave: number;
  front: number;
  walking: number;
  airborne: number;
  phase: number;
  distance: number;
  facing: 1 | -1;
  facingScale: number;
  fromFacing: 1 | -1;
  fromFacingScale: number;
  turnProgress: number;
  action: ActionId | null;
  fromAction: ActionId | null;
  transition: number;
  duration: number;
}

export interface PoseInput {
  height: number;
  action: ActionId;
  time: number;
  clock?: number;
  dt: number;
  verticalVelocity: number;
  landProgress: number;
  landStrength?: number;
  facing: 1 | -1;
  distance?: number;
  horizontalSpeed?: number;
  turnProgress?: number;
  actionDuration?: number;
  climb?: { normal: Point; distance: number; attachment?: ClimbAttachmentSample; speed?: number };
  reach?: { normal: Point; distance: number; progress: number };
}

export function createPose(): Pose {
  return {
    joints: new Float64Array(24), footAngles: new Float64Array(2), headRadius: 0,
    compression: 0, arm: -0.10, bend: 0.12, tuck: 0, lean: 0, hip: -0.507,
    runMix: 0, sprint: 0, crouch: 0, rest: 0, prone: 0, roll: 0, rollProgress: 0, rollAngle: 0, airProgress: 0, standProne: 0, standCrouch: 0, standSit: 0, standLeftFoot: { x: 0, y: 0 }, standRightFoot: { x: 0, y: 0 }, standFootAngles: new Float64Array(2), sit: 0, question: 0, inPlace: 0, inPlacePhase: 0, climbing: 0, climbNormal: { x: -1, y: 0 }, climbDistance: 0, climbAngle: 0, climbGather: 1, climbLeftFoot: 1, climbRightFoot: 1, climbMoving: 1, airLead: -1, wave: 0, front: 0, walking: 0, airborne: 0,
    phase: 0, distance: 0,
    facing: 1, facingScale: 1, fromFacing: 1, fromFacingScale: 1, turnProgress: 1,
    action: null, fromAction: null, transition: 1, duration: 0.16,
  };
}

export function samplePose(output: Pose, input: PoseInput): void {
  const h = input.height;
  const action = input.action;
  const dt = Math.max(0, input.dt);
  const actionChanged = output.action !== action;
  const facingChanged = output.facing !== input.facing;
  if (actionChanged && action === 'stand-up') {
    output.standProne = output.prone;
    output.standCrouch = output.crouch;
    output.standSit = output.sit;
    output.standLeftFoot = { x: output.joints[JOINT.leftFoot * 2]! * output.facing, y: output.joints[JOINT.leftFoot * 2 + 1]! };
    output.standRightFoot = { x: output.joints[JOINT.rightFoot * 2]! * output.facing, y: output.joints[JOINT.rightFoot * 2 + 1]! };
    output.standFootAngles.set(output.footAngles);
  }
  if (actionChanged && action === 'roll') output.rollProgress = 0;
  if (actionChanged && output.action === 'run-in-place' && (action === 'walk' || action === 'run' || action === 'sprint')) output.phase = output.inPlacePhase;
  if (actionChanged && action === 'run-in-place') output.inPlacePhase = 0;
  if (actionChanged && (action === 'jump' || action === 'run-jump' || action === 'running-long-jump')) {
    output.airLead = (output.joints[JOINT.leftFoot * 2]! - output.joints[JOINT.rightFoot * 2]!) * input.facing >= 0 ? -1 : 1;
    output.airProgress = 0;
  }
  if ((output.action !== null && actionChanged) || facingChanged) {
    output.fromAction = output.action;
    output.fromFacing = output.facing;
    output.duration = transitionDuration(output.action, action);
    output.transition = 0;
    if (facingChanged) { output.fromFacingScale = output.facingScale; output.turnProgress = 0; }
  }
  output.action = action;
  output.facing = input.facing;
  output.transition = Math.min(1, output.transition + dt / output.duration);
  if (action === 'turn' && input.turnProgress !== undefined) output.turnProgress = clamp01(input.turnProgress);
  else output.turnProgress = Math.min(1, output.turnProgress + dt / TURN_DURATION);
  output.facingScale = mix(output.fromFacingScale, input.facing, smoothstep(output.turnProgress));

  const landing = action === 'land-soft';
  const jumping = action === 'jump' || action === 'run-jump' || action === 'running-long-jump';
  const falling = action === 'fall';
  const airborne = jumping || falling;
  const rolling = action === 'roll';
  const airProgress = input.verticalVelocity < 0 ? clamp01(input.time / 0.3) : 1;
  const descending = smoothstep(clamp01(Math.max(0, input.verticalVelocity) / 280));
  output.airProgress = mix(output.airProgress, airborne ? airProgress : 0, 1 - Math.exp(-dt / 0.04));
  const rollProgress = rolling ? clamp01(input.time / (input.actionDuration ?? ROLL_DURATION)) : output.rollProgress;
  if (rolling) output.rollProgress = rollProgress;
  output.roll = mix(output.roll, rolling ? 1 : 0, 1 - Math.exp(-dt / 0.045));
  output.rollAngle = 0;
  const roll = output.roll > 1e-5 ? rollFrame(output.rollProgress) : ROLL_FRAMES[0]!;
  const inPlace = action === 'run-in-place';
  const climbing = action === 'climb' && input.climb !== undefined;
  if (input.climb) {
    output.climbNormal.x = input.climb.normal.x * input.facing;
    output.climbNormal.y = input.climb.normal.y;
    output.climbDistance = input.climb.distance;
    output.climbAngle = input.climb.attachment?.angle ?? 0;
    output.climbGather = input.climb.attachment?.gather ?? 1;
    output.climbLeftFoot = input.climb.attachment?.leftFoot ?? 1;
    output.climbRightFoot = input.climb.attachment?.rightFoot ?? 1;
  }
  const normal = output.climbNormal;
  const climbPhase = output.climbDistance / (h * CLIMB_STRIDE);
  const preparing = action === 'anticipate';
  const speed = Math.abs(input.horizontalSpeed ?? 0);
  const movingTransition = (action === 'brake' || preparing || landing) && speed > 0.5;
  const walking = action === 'walk' || action === 'run' || action === 'sprint' || movingTransition;
  const running = inPlace || action === 'run' || action === 'sprint' || action === 'run-jump' || action === 'running-long-jump' || (movingTransition && (speed > h * 2 || output.runMix > 0.5));
  const idleLike = !airborne && !walking && !rolling && action !== 'prone';
  const breath = idleLike ? Math.sin((input.clock ?? 0) * 1.9) : 0;
  const sway = idleLike ? Math.sin((input.clock ?? 0) * 1.9 + 0.8) : 0;
  const pulse = Math.sin(Math.PI * output.transition);
  const tau = output.transition < 1 ? Math.max(0.06, output.duration * 0.38) : 0.06;
  const blend = 1 - Math.exp(-dt / tau);
  const waveDuration = input.actionDuration ?? POSE_DURATION.wave;
  const waveEnvelope = action === 'wave' ? smoothstep(Math.min(clamp01(input.time / 0.22), clamp01((waveDuration - input.time) / 0.22))) : 0;
  const landStrength = clamp01(input.landStrength ?? 0.45);
  const targetCompression = (landing ? mix(0.075, 0.19, landStrength) * Math.sin(Math.PI * clamp01(input.landProgress)) : preparing ? 0.085 : 0) + (action === 'brake' ? 0.015 * pulse : 0);
  const targetTuck = airborne ? (jumping ? Math.sin(Math.PI * output.airProgress / 2) * mix(0.13, 0.035, descending) : mix(0.075, 0.035, descending)) : 0;
  const targetLean = action === 'sprint' ? 0.43 : preparing ? 0.22 : landing ? mix(0.20, 0.42, landStrength) : action === 'crouch' || action === 'stand-up' ? 0.50 * (action === 'crouch' ? 1 : output.crouch) : running && !airborne ? 0.33 : walking ? 0.035 : action === 'running-long-jump' ? mix(0.32, 0.12, descending) : jumping ? 0.14 : falling ? 0.10 : action === 'wave' ? -0.04 : 0;
  output.compression = mix(output.compression, targetCompression, blend);
  output.arm = mix(output.arm, jumping ? mix(2.15, 0.72, descending) : preparing ? -0.62 : falling ? mix(1.0, 0.70, descending) : action === 'crouch' ? 1.12 : -0.08, blend);
  output.bend = mix(output.bend, jumping ? mix(0.35, 0.62, descending) : preparing ? 0.30 : falling ? 0.50 : walking ? 0.22 : action === 'crouch' ? 0.36 : 0.12, blend);
  output.tuck = mix(output.tuck, targetTuck, blend);
  output.runMix = mix(output.runMix, running ? 1 : 0, blend);
  output.sprint = mix(output.sprint, action === 'sprint' || action === 'running-long-jump' ? 1 : 0, blend);
  const standProgress = clamp01(input.time / (input.actionDuration ?? (output.standSit > 0.01 ? SIT_STAND_DURATION : STAND_DURATION)));
  if (action === 'stand-up') {
    output.sit = output.standSit * (1 - smoothstep(clamp01((standProgress - 0.52) / 0.48)));
    output.prone = output.standProne * (1 - smoothstep(clamp01(standProgress / 0.56)));
    output.crouch = output.standCrouch * (1 - smoothstep(standProgress)) + output.standProne * Math.sin(Math.PI * smoothstep(standProgress)) * 0.85;
  } else {
    output.sit = mix(output.sit, action === 'sit' ? smoothstep(clamp01(input.time / SIT_DOWN_DURATION)) : 0, blend);
    const lowering = action === 'prone' ? clamp01(input.time / STAND_DURATION) : 0;
    output.crouch = mix(output.crouch, action === 'crouch' ? 1 : Math.sin(Math.PI * lowering) * 0.65, blend);
    output.prone = mix(output.prone, action === 'prone' ? smoothstep(clamp01((lowering - 0.25) / 0.75)) : 0, blend);
  }
  output.question = mix(output.question, action === 'question' ? 1 : 0, blend);
  output.inPlace = mix(output.inPlace, inPlace ? 1 : 0, blend);
  output.climbing = mix(output.climbing, climbing ? 1 : 0, blend);
  output.climbMoving = mix(output.climbMoving, input.climb && (input.climb.speed === undefined || input.climb.speed > h * 0.03) ? 1 : 0, 1 - Math.exp(-dt / 0.12));
  if (inPlace || output.inPlace > 1e-5) output.inPlacePhase += dt * IN_PLACE_CADENCE;
  output.rest = mix(output.rest, action === 'rest' ? 1 : 0, blend);
  output.wave = mix(output.wave, waveEnvelope, blend);
  output.hip = mix(output.hip, -0.507, blend);
  output.lean = mix(output.lean, targetLean, blend);
  output.front = mix(output.front, Math.max(output.wave * 0.65, output.rest * 0.85, 1 - Math.abs(output.facingScale)), blend);
  output.walking = mix(output.walking, walking ? Math.min(1, speed / (h * 0.6)) : 0, blend);
  output.airborne = mix(output.airborne, airborne ? 1 : 0, blend);
  output.headRadius = h * 0.10;

  const runStride = Math.max(mix(1.42, 1.8, output.sprint), Math.min(2.65, speed / (h * 2.65)));
  const cycleLength = h * mix(0.76, runStride, output.runMix);
  const distance = input.distance ?? 0;
  output.phase += Math.max(0, distance - output.distance) / cycleLength;
  output.distance = distance;
  const phase = mix(output.phase, output.inPlacePhase, output.inPlace);
  const sitLower = smoothstep(clamp01(output.sit / 0.65));
  const sitLegs = smoothstep(clamp01((output.sit - 0.45) / 0.55));
  const sitArms = smoothstep(clamp01((output.sit - 0.25) / 0.30));
  const hangingChest = climbPoint(normal, 0.60, 0.16);
  const steadyChest = climbPoint(normal, 0.60 + Math.sin(climbPhase * Math.PI * 4) * 0.010 * output.climbMoving, CLIMB_CHEST_GAP);
  const climbingLean = Math.atan2(-normal.y, -normal.x) + 0.26;
  const attachmentLean = mixAngle(output.climbAngle, climbingLean, output.climbGather);
  const climbingChest = { x: mix(hangingChest.x, steadyChest.x, output.climbGather), y: mix(hangingChest.y, steadyChest.y, output.climbGather) };
  const climbingHip = { x: climbingChest.x - Math.sin(attachmentLean) * 0.22, y: climbingChest.y + Math.cos(attachmentLean) * 0.22 };
  const feet = ([-1, 1] as const).map((side) => {
    const q = ((phase + (side === -1 ? 0 : 0.5)) % 1 + 1) % 1;
    const walk = gaitFoot(q, false, 0, 0.76), run = gaitFoot(q, true, output.sprint, runStride);
    let x = mix(side * 0.04, mix(walk.x, run.x, output.runMix), output.walking);
    let y = mix(walk.y, run.y, output.runMix) * output.walking;
    const leading = side === output.airLead;
    const airX = jumping ? mix(side * 0.075, leading ? mix(0.16, 0.11, descending) : mix(-0.19, -0.055, descending), output.runMix) : side * 0.085;
    x = mix(x, airX, output.airborne);
    y = mix(y, -output.tuck * (leading ? 1 : 0.55), output.airborne);
    x = mix(x, side * 0.085, output.front * (1 - output.walking) * (1 - output.airborne));
    x = mix(x, -0.745, output.prone);
    y = mix(y, 0, output.prone);
    const stationaryPhase = ((output.inPlacePhase + (side === -1 ? 0 : 0.5)) % 1 + 1) % 1;
    const lift = stationaryPhase < 0.5 ? Math.sin(stationaryPhase * Math.PI * 2) : 0;
    x = mix(x, side * 0.025 + lift * 0.12, output.inPlace);
    y = mix(y, -lift * 0.29, output.inPlace);
    x = mix(x, side === -1 ? 0.31 : 0.46, sitLegs);
    y = mix(y, Math.sin(-0.12) * FOOT_HEEL_LENGTH, sitLegs);
    const rolledFoot = roll.feet[side === -1 ? 0 : 1];
    x = mix(x, rolledFoot.x, output.roll);
    y = mix(y, rolledFoot.y, output.roll);
    const brace = side === -1 ? output.climbLeftFoot : output.climbRightFoot;
    const climbingAngle = Math.atan2(-normal.y, -normal.x) - 0.12;
    if (output.climbing > 1e-5) {
      const pivot = climbPoint(normal, 0.60, 0.16);
      const chain = 0.22 + 0.47;
      const hanging = { x: pivot.x - Math.sin(output.climbAngle) * chain + side * Math.cos(output.climbAngle) * 0.012, y: pivot.y + Math.cos(output.climbAngle) * chain + side * Math.sin(output.climbAngle) * 0.012 };
      const grip = climbGrip(normal, climbPhase + (side === -1 ? 0.25 : 0.75), false, output.climbMoving);
      const ankle = { x: grip.x - Math.cos(climbingAngle) * FOOT_TOE_LENGTH, y: grip.y - Math.sin(climbingAngle) * FOOT_TOE_LENGTH };
      const target = { x: mix(hanging.x, ankle.x, brace), y: mix(hanging.y, ankle.y, brace) };
      x = mix(x, target.x, output.climbing);
      y = mix(y, target.y, output.climbing);
    }
    const groundAngle = mix(walk.angle, run.angle, output.runMix) * output.walking * (1 - output.prone);
    const airAngle = jumping ? mix(leading ? -0.12 : 0.55, -0.10, descending) : 0.12;
    let angle = mix(groundAngle, airAngle, output.airborne);
    angle = mix(angle, lift ? -0.15 : 0, output.inPlace);
    angle = mix(angle, -0.12, sitLegs);
    angle = mix(angle, rollProgress < 0.34 || rollProgress > 0.76 ? 0 : -0.35, output.roll);
    angle = mix(angle, 0.12, output.climbing * (1 - brace));
    angle = mix(angle, climbingAngle, output.climbing * brace);
    if (action === 'stand-up' && output.standSit > 0.01) {
      const begin = side === -1 ? 0.02 : 0.27;
      const progress = clamp01((standProgress - begin) / 0.25);
      const initial = side === -1 ? output.standLeftFoot : output.standRightFoot;
      const initialAngle = output.standFootAngles[side === -1 ? 0 : 1]!;
      const targetAngle = mix(initialAngle, 0, smoothstep(progress));
      const lift = progress > 0 && progress < 1 ? Math.sin(Math.PI * progress) * h * 0.08 : 0;
      x = mix(x, mix(initial.x / h, side === -1 ? -0.04 : 0.06, smoothstep(progress)), output.standSit);
      y = mix(y, Math.sin(targetAngle) * FOOT_HEEL_LENGTH - lift / h, output.standSit);
      angle = mix(angle, targetAngle, output.standSit);
    }
    output.footAngles[side === -1 ? 0 : 1] = angle;
    if (action === 'sit') y = Math.sin(angle) * FOOT_HEEL_LENGTH;
    return { side, x: x * h, y: y * h };
  });
  if (action === 'land-soft') {
    for (const foot of feet) foot.y = 0;
  } else if (!airborne && !rolling && output.climbing < 1e-5) {
    const highestFoot = Math.max(...feet.map((foot, index) => foot.y - Math.sin(output.footAngles[index]!) * h * FOOT_HEEL_LENGTH * (action === 'sit' || action === 'stand-up' && output.standSit > 0.01 ? 1 : output.sit)));
    for (const foot of feet) foot.y -= highestFoot;
  }
  const runPhase = ((phase % 0.5) + 0.5) % 0.5;
  const stance = mix(1.42 * 0.32, 1.8 * 0.28, output.sprint) / runStride;
  const supportProgress = clamp01(runPhase / stance);
  const flightProgress = clamp01((runPhase - stance) / (0.5 - stance));
  const runHip = runPhase < stance ? -0.477 + 0.034 * Math.sin(Math.PI * supportProgress) - 0.008 * smoothstep(clamp01((supportProgress - 0.65) / 0.35)) : mix(-0.485, -0.477, smoothstep(flightProgress)) - 0.024 * Math.sin(Math.PI * flightProgress);
  const walkHip = -0.487 + 0.016 * Math.cos(phase * Math.PI * 4);
  const hip = {
    x: (sway * 0.003 + output.runMix * output.walking * 0.018 - output.crouch * 0.12 - output.prone * 0.24) * h,
    y: h * mix(mix(output.hip, mix(walkHip, runHip, output.runMix), output.walking) + output.compression + output.crouch * 0.21, -0.075, output.prone) - breath * h * 0.002,
  };
  hip.x = mix(hip.x, 0.01 * h, output.inPlace);
  hip.y = mix(hip.y, (-0.47 - Math.sin(phase * Math.PI * 4) * 0.008) * h, output.inPlace);
  hip.x = mix(hip.x, -0.035 * h, sitLower);
  hip.y = mix(hip.y, 0, sitLower);
  hip.x = mix(hip.x, roll.hip.x * h, output.roll);
  hip.y = mix(hip.y, roll.hip.y * h, output.roll);
  if (output.climbing > 1e-5) {
    hip.x = mix(hip.x, climbingHip.x * h, output.climbing);
    hip.y = mix(hip.y, climbingHip.y * h, output.climbing);
  }
  if (output.climbing < 1e-5) for (const foot of feet) {
    const dx = foot.x - hip.x;
    const reach = Math.sqrt(Math.max(0, (h * 0.5095) ** 2 - dx ** 2));
    hip.y = Math.max(hip.y, foot.y - reach);
  }
  let lean = mix(output.lean + Math.sin(phase * Math.PI * 4) * 0.012 * output.walking, Math.PI / 2 - 0.12, output.prone);
  lean = mixAngle(lean, -0.22 + breath * 0.012, sitLower);
  lean = mixAngle(lean, 0.10, output.inPlace);
  lean = mixAngle(lean, roll.lean, output.roll);
  lean = mixAngle(lean, attachmentLean, output.climbing);
  const chest = { x: hip.x + Math.sin(lean) * h * 0.22, y: hip.y - Math.cos(lean) * h * 0.22 };
  const turnFront = 1 - Math.abs(output.facingScale);
  const put = (id: number, x: number, y: number, frontX = 0) => {
    output.joints[id * 2] = x * output.facingScale + frontX * turnFront;
    output.joints[id * 2 + 1] = y;
  };
  put(JOINT.pelvis, hip.x, hip.y);
  put(JOINT.chest, chest.x, chest.y);
  const wallUp = Math.atan2(-normal.y, -normal.x);
  const neckLean = mixAngle(mixAngle(lean, roll.neck, output.roll), wallUp, output.climbing);
  const neck = { x: chest.x + Math.sin(neckLean) * h * 0.065, y: chest.y - Math.cos(neckLean) * h * 0.065 };
  const headLean = mixAngle(mixAngle(lean, roll.head, output.roll), wallUp, output.climbing);
  put(JOINT.neck, neck.x, neck.y);
  const head = { x: neck.x + Math.sin(headLean) * h * 0.12, y: neck.y - Math.cos(headLean) * h * 0.12 };
  put(JOINT.head, head.x, head.y);

  const legs = feet.map(foot => {
    const first = solveTwoBone(hip, { x: foot.x, y: foot.y }, h * 0.255, h * 0.255, -1);
    if (output.climbing < 1e-5 || first.joint.x * normal.x + first.joint.y * normal.y + h * 0.26 >= h * 0.015) return { ...foot, leg: first };
    const alternate = solveTwoBone(hip, { x: foot.x, y: foot.y }, h * 0.255, h * 0.255, 1);
    return { ...foot, leg: alternate.joint.x * normal.x + alternate.joint.y * normal.y > first.joint.x * normal.x + first.joint.y * normal.y ? alternate : first };
  });
  for (let i = 0; i < legs.length; i++) {
    const { side, leg } = legs[i]!;
    const other = legs[1 - i]!.leg;
    put(side === -1 ? JOINT.leftKnee : JOINT.rightKnee, leg.joint.x, leg.joint.y, side * Math.abs(leg.joint.x - hip.x));
    put(side === -1 ? JOINT.leftFoot : JOINT.rightFoot, leg.end.x, leg.end.y, side * Math.abs(leg.end.x - hip.x));

    const thigh = Math.atan2(leg.joint.x - hip.x, leg.joint.y - hip.y);
    const otherThigh = Math.atan2(other.joint.x - hip.x, other.joint.y - hip.y);
    const swing = Math.tanh((otherThigh - thigh) * mix(0.74, 1.20 + output.sprint * 0.08, output.runMix));
    const walkSwing = -Math.cos(phase * Math.PI * 2) * (side === -1 ? 1 : -1);
    const armSwing = mix(walkSwing * 0.42, swing * (1.24 + output.sprint * 0.08), output.runMix) * output.walking;
    let upperAngle = output.arm + armSwing + breath * 0.015;
    const runningBend = mix(0.92, 1.44, smoothstep(clamp01((swing + 1) / 2)));
    let forearmAngle = upperAngle + mix(output.bend, runningBend, output.runMix * output.walking);
    const leading = side === output.airLead;
    const airUpper = jumping ? mix(output.arm + side * 0.10, leading ? mix(-0.55, 0.28, descending) : mix(1.95, 0.85, descending), output.runMix) : 0.78 + side * 0.18;
    const airBend = jumping ? mix(output.bend, leading ? mix(0.42, 0.60, descending) : mix(1.00, 0.62, descending), output.runMix) : 0.56;
    upperAngle = mixAngle(upperAngle, airUpper, output.airborne);
    forearmAngle = mixAngle(forearmAngle, airUpper + airBend, output.airborne);
    upperAngle = mixAngle(upperAngle, side * 0.24, output.front);
    forearmAngle = mixAngle(forearmAngle, side * 0.12, output.front);
    if (side === 1) {
      upperAngle = mixAngle(upperAngle, 1.95 + Math.sin(input.time * 4) * 0.035, output.wave);
      forearmAngle = mixAngle(forearmAngle, 3.06 + Math.sin(input.time * 14) * 0.40, output.wave);
    }
    const resting = solveTwoBone(chest, { x: hip.x + side * h * 0.075, y: hip.y - h * 0.025 }, h * 0.19, h * 0.18, side === -1 ? 1 : -1);
    upperAngle = mixAngle(upperAngle, Math.atan2(resting.joint.x - chest.x, resting.joint.y - chest.y), output.rest);
    forearmAngle = mixAngle(forearmAngle, Math.atan2(resting.end.x - resting.joint.x, resting.end.y - resting.joint.y), output.rest);
    const lyingUpper = Math.acos(clamp01((-h * 0.006 - chest.y) / (h * 0.19)));
    upperAngle = mixAngle(upperAngle, lyingUpper, output.prone);
    forearmAngle = mixAngle(forearmAngle, Math.PI / 2, output.prone);
    const stationarySwing = Math.sin(phase * Math.PI * 2) * (side === -1 ? -1 : 1);
    const stationaryUpper = -0.16 + stationarySwing * 0.62;
    upperAngle = mixAngle(upperAngle, stationaryUpper, output.inPlace);
    forearmAngle = mixAngle(forearmAngle, stationaryUpper + Math.PI / 2 - 0.10 + stationarySwing * 0.04, output.inPlace);
    const constrainHand = (target: Point, amount: number, bend: 1 | -1 = 1) => {
      if (amount <= 1e-5) return;
      const arm = solveTwoBone(chest, target, h * 0.19, h * 0.18, bend);
      upperAngle = mixAngle(upperAngle, Math.atan2(arm.joint.x - chest.x, arm.joint.y - chest.y), amount);
      forearmAngle = mixAngle(forearmAngle, Math.atan2(arm.end.x - arm.joint.x, arm.end.y - arm.joint.y), amount);
    };
    if (output.sit > 1e-5) constrainHand({ x: h * (side === -1 ? -0.28 : -0.24), y: 0 }, sitArms, -1);
    if (side === 1 && output.question > 1e-5) constrainHand({ x: head.x - h * 0.005, y: head.y - h * 0.055 + Math.sin(input.time * 8) * h * 0.035 }, output.question);
    if (output.roll > 1e-5) {
      const rollingHand = roll.hands[side === -1 ? 0 : 1];
      constrainHand({ x: rollingHand.x * h, y: rollingHand.y * h }, output.roll, -1);
    }
    if (input.reach && airborne) {
      const reachingNormal = { x: input.reach.normal.x * input.facing, y: input.reach.normal.y };
      const reachingHand = climbPoint(reachingNormal, side === -1 ? 0.70 : 0.50, 0.26 - input.reach.distance / h);
      constrainHand({ x: reachingHand.x * h, y: reachingHand.y * h }, clamp01(input.reach.progress), -1);
    }
    if (output.climbing > 1e-5) {
      const climbingHand = climbGrip(normal, climbPhase + (side === -1 ? 0 : 0.5), true, output.climbMoving);
      // 已建立的手部接触不能随全身融合滑离墙面。
      constrainHand({ x: climbingHand.x * h, y: climbingHand.y * h }, climbing ? 1 : output.climbing, -1);
    }
    upperAngle = mixAngle(upperAngle, side * 0.32, turnFront);
    forearmAngle = mixAngle(forearmAngle, side * 0.18, turnFront);
    const upperX = Math.sin(upperAngle) * h * 0.19;
    const lowerX = Math.sin(forearmAngle) * h * 0.18;
    const elbow = {
      x: chest.x + upperX,
      y: chest.y + Math.cos(upperAngle) * h * 0.19,
    };
    const hand = {
      x: elbow.x + lowerX,
      y: elbow.y + Math.cos(forearmAngle) * h * 0.18,
    };
    put(side === -1 ? JOINT.leftElbow : JOINT.rightElbow, elbow.x, elbow.y, side * Math.abs(upperX));
    put(side === -1 ? JOINT.leftHand : JOINT.rightHand, hand.x, hand.y, side * Math.abs(upperX + lowerX));
  }
  if (output.roll > 1e-5) {
    let bottom = output.joints[JOINT.head * 2 + 1]! + output.headRadius;
    for (let i = 1; i < output.joints.length; i += 2) bottom = Math.max(bottom, output.joints[i]!);
    for (const [index, foot] of [JOINT.leftFoot, JOINT.rightFoot].entries()) {
      const y = output.joints[foot * 2 + 1]!, dy = Math.sin(output.footAngles[index]!) * h;
      bottom = Math.max(bottom, y - dy * 0.035, y + dy * 0.075);
    }
    if (!airborne) for (let i = 1; i < output.joints.length; i += 2) output.joints[i] = output.joints[i]! - bottom;
  }
}
