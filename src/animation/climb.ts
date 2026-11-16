import type { Point } from '../scene/types';

export const CLIMB_ATTACH_DURATION = 0.9;

export interface ClimbAttachmentSample {
  generation: number;
  angle: number;
  gather: number;
  leftFoot: number;
  rightFoot: number;
  ready: boolean;
  failed: boolean;
}

export interface ClimbAttachmentState extends ClimbAttachmentSample {
  time: number;
  angularVelocity: number;
}

const CHAIN_LENGTH = 0.73;
const CHEST_CLEARANCE = 0.16;
const TOE_REACH = 0.075;
const MIN_GATHER_TIME = 0.12;
const LATEST_GATHER_TIME = 0.38;
const MAX_ANGLE = 0.62;
const MAX_ANGULAR_VELOCITY = 8;
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
const smooth = (value: number) => {
  const t = clamp(value, 0, 1);
  return t * t * (3 - 2 * t);
};

function failedState(generation: number, time = 0): ClimbAttachmentState {
  return { generation: Number.isFinite(generation) ? generation : 0, time: Number.isFinite(time) ? clamp(time, 0, CLIMB_ATTACH_DURATION) : 0, angle: 0.28, angularVelocity: 0, gather: 0, leftFoot: 0, rightFoot: 0, ready: false, failed: true };
}

function wallGeometry(normal: Point): { x: number; y: number; lowerAngle: number } | null {
  const length = Math.hypot(normal.x, normal.y);
  if (!Number.isFinite(length) || length <= 0) return null;
  const x = normal.x / length, y = normal.y / length;
  if (Math.abs(x) < Math.cos(10 * Math.PI / 180)) return null;
  const slope = Math.atan2(y, Math.abs(x));
  return { x, y, lowerAngle: Math.asin((TOE_REACH - CHEST_CLEARANCE) / CHAIN_LENGTH) - slope };
}

export function captureClimbAttachment(generation: number, velocity: Point, normal: Point, height: number, gravity: number): ClimbAttachmentState {
  const wall = wallGeometry(normal);
  if (!wall || ![height, gravity, velocity.x, velocity.y].every(Number.isFinite) || height <= 0 || gravity <= 0) return failedState(generation);
  const slope = Math.atan2(wall.y, Math.abs(wall.x));
  const angle = clamp(Math.max(wall.lowerAngle + 0.14, 0.28 - slope * 0.3), wall.lowerAngle, MAX_ANGLE);
  const outwardSpeed = velocity.x * Math.sign(wall.x);
  const angularVelocity = clamp((outwardSpeed * Math.cos(angle) - velocity.y * Math.sin(angle)) / (height * CHAIN_LENGTH), -4.8, 4.8);
  return { generation, time: 0, angle, angularVelocity, gather: 0, leftFoot: 0, rightFoot: 0, ready: false, failed: false };
}

function swing(angle: number, velocity: number, dt: number, stiffness: number, damping: number): readonly [number, number] {
  const acceleration = (a: number, v: number) => -stiffness * Math.sin(a) - damping * v;
  const a1 = velocity, v1 = acceleration(angle, velocity);
  const a2 = velocity + v1 * dt / 2, v2 = acceleration(angle + a1 * dt / 2, velocity + v1 * dt / 2);
  const a3 = velocity + v2 * dt / 2, v3 = acceleration(angle + a2 * dt / 2, velocity + v2 * dt / 2);
  const a4 = velocity + v3 * dt, v4 = acceleration(angle + a3 * dt, velocity + v3 * dt);
  return [angle + dt * (a1 + 2 * a2 + 2 * a3 + a4) / 6, velocity + dt * (v1 + 2 * v2 + 2 * v3 + v4) / 6];
}

export function stepClimbAttachment(state: Readonly<ClimbAttachmentState>, dt: number, normal: Point, height: number, gravity: number): ClimbAttachmentState {
  if (state.failed) return { ...state };
  const wall = wallGeometry(normal);
  if (!wall || ![dt, height, gravity, state.time, state.angle, state.angularVelocity, state.gather].every(Number.isFinite) || dt < 0 || height <= 0 || gravity <= 0) return failedState(state.generation, Number.isFinite(state.time) ? state.time : 0);
  if (state.ready || dt === 0) return { ...state };
  const duration = Math.min(dt, Math.max(0, CLIMB_ATTACH_DURATION - state.time));
  const time = Math.min(CLIMB_ATTACH_DURATION, state.time + duration);
  if (duration <= 0) return failedState(state.generation, time);
  // 角频率上限只约束极小画布的局部摆动，不改世界重力。
  const stiffness = Math.min(gravity / (height * CHAIN_LENGTH), 24 ** 2);
  const damping = 0.92 * Math.sqrt(stiffness);
  const steps = Math.max(1, Math.ceil(duration * 240));
  const step = duration / steps;
  let angle = clamp(state.angle, wall.lowerAngle, MAX_ANGLE), angularVelocity = state.angularVelocity;
  let closest = false;
  for (let i = 0; i < steps; i++) {
    const before = angularVelocity;
    [angle, angularVelocity] = swing(angle, angularVelocity, step, stiffness, damping);
    if (angle < wall.lowerAngle) {
      angle = wall.lowerAngle;
      angularVelocity = Math.max(0, -angularVelocity * 0.08);
    } else if (angle > MAX_ANGLE) {
      angle = MAX_ANGLE;
      angularVelocity = Math.min(0, -angularVelocity * 0.08);
    }
    angularVelocity = clamp(angularVelocity, -MAX_ANGULAR_VELOCITY, MAX_ANGULAR_VELOCITY);
    if (before < 0 && angularVelocity >= 0) closest = true;
  }
  const toeDistance = CHEST_CLEARANCE + CHAIN_LENGTH * (Math.abs(wall.x) * Math.sin(angle) + wall.y * Math.cos(angle)) - TOE_REACH;
  const gathering = state.gather > 0 || time >= LATEST_GATHER_TIME || time >= MIN_GATHER_TIME && (closest || toeDistance <= 0.025);
  const remaining = CLIMB_ATTACH_DURATION - state.time;
  const gather = gathering ? clamp(state.gather + (1 - state.gather) * duration / Math.max(duration, remaining), 0, 1) : 0;
  const leftFoot = smooth((gather - 0.25) / 0.35);
  const rightFoot = smooth((gather - 0.60) / 0.40);
  const ready = time >= CLIMB_ATTACH_DURATION - 1e-10 && gather >= 1 - 1e-10 && rightFoot >= 1 - 1e-10;
  if (ready) return { generation: state.generation, time: CLIMB_ATTACH_DURATION, angle: 0, angularVelocity: 0, gather: 1, leftFoot: 1, rightFoot: 1, ready: true, failed: false };
  return { generation: state.generation, time, angle, angularVelocity, gather, leftFoot, rightFoot, ready: false, failed: false };
}

export function sampleClimbAttachment(previous: ClimbAttachmentState | null, current: ClimbAttachmentState, alpha: number): ClimbAttachmentSample {
  if (!previous || previous.generation !== current.generation || previous.failed || current.failed) {
    return { generation: current.generation, angle: current.angle, gather: current.gather, leftFoot: current.leftFoot, rightFoot: current.rightFoot, ready: current.ready, failed: current.failed };
  }
  const t = clamp(alpha, 0, 1);
  const mix = (a: number, b: number) => a + (b - a) * t;
  return { generation: current.generation, angle: mix(previous.angle, current.angle), gather: mix(previous.gather, current.gather), leftFoot: mix(previous.leftFoot, current.leftFoot), rightFoot: mix(previous.rightFoot, current.rightFoot), ready: current.ready && (previous.ready || t === 1), failed: false };
}
