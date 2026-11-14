import type { Body, Point, StepResult, SurfaceSnapshot } from '../scene/types';

function displacement(v: number, gravity: number, time: number, terminal: number): number {
  const accelerationTime = Math.min(time, Math.max(0, (terminal - v) / gravity));
  const accelerated = v * accelerationTime + gravity * accelerationTime ** 2 / 2;
  return accelerationTime === time ? accelerated : accelerated + terminal * (time - accelerationTime);
}

interface FlightCollision {
  surfaceId: string;
  time: number;
  kind: 'land' | 'wall' | 'ceiling';
  normal: Point;
  u: number;
}

function crossingTime(vy: number, dy: number, gravity: number, terminal: number, ascending = false): number | null {
  const discriminant = vy * vy + 2 * gravity * dy;
  if (discriminant <= 0) return null;
  let time = (-vy + (ascending ? -1 : 1) * Math.sqrt(discriminant)) / gravity;
  const accelerationTime = Math.max(0, (terminal - vy) / gravity);
  if (!ascending && time > accelerationTime) {
    time = accelerationTime + (dy - displacement(vy, gravity, accelerationTime, terminal)) / terminal;
  }
  return time >= -1e-9 ? Math.max(0, time) : null;
}

export function firstCollision(body: Body, surfaces: readonly SurfaceSnapshot[], duration: number, gravity: number, footRadius: number, bodyHeight: number, terminalSpeed = Number.POSITIVE_INFINITY, ignoredId?: string): FlightCollision | null {
  const vy = Math.min(body.velocity.y, terminalSpeed);
  let first: FlightCollision | null = null;
  const consider = (collision: FlightCollision) => {
    if (collision.time <= duration + 1e-9 && (!first || collision.time < first.time - 1e-9)) first = collision;
  };
  for (const surface of surfaces) {
    if (surface.status !== 'valid' || surface.id === ignoredId || Math.abs(surface.a.y - surface.b.y) > 1e-6) continue;
    const time = crossingTime(vy, surface.a.y - body.position.y, gravity, terminalSpeed);
    const width = surface.b.x - surface.a.x;
    if (time !== null && time <= duration + 1e-9 && vy + gravity * time > 0 && width > 0) {
      const x = body.position.x + body.velocity.x * time;
      if (surface.available.some((range) => x - footRadius >= surface.a.x + range.start * width - 1e-6 && x + footRadius <= surface.a.x + range.end * width + 1e-6)) {
        consider({ surfaceId: surface.id, time, kind: 'land', normal: { x: 0, y: -1 }, u: (x - surface.a.x) / width });
      }
    }
    const bounds = surface.bounds;
    if (!bounds || bounds.right <= bounds.left || bounds.bottom <= bounds.top) continue;
    const vx = body.velocity.x;
    const edge = vx > 0 ? bounds.left - footRadius : bounds.right + footRadius;
    if (vx && (vx > 0 ? body.position.x <= edge + 1e-6 : body.position.x >= edge - 1e-6)) {
      const time = (edge - body.position.x) / vx;
      if (time >= -1e-9 && time <= duration + 1e-9) {
        const y = body.position.y + displacement(vy, gravity, Math.max(0, time), terminalSpeed);
        if (y > bounds.top + 1e-6 && y - bodyHeight < bounds.bottom - 1e-6) {
          consider({ surfaceId: surface.id, time: Math.max(0, time), kind: 'wall', normal: { x: vx > 0 ? -1 : 1, y: 0 }, u: 0 });
        }
      }
    }
    if (vy < 0 && body.position.y - bodyHeight >= bounds.bottom - 1e-6) {
      const time = crossingTime(vy, bounds.bottom + bodyHeight - body.position.y, gravity, terminalSpeed, true);
      if (time !== null && time <= duration + 1e-9) {
        const x = body.position.x + vx * time;
        if (x + footRadius > bounds.left + 1e-6 && x - footRadius < bounds.right - 1e-6) {
          consider({ surfaceId: surface.id, time, kind: 'ceiling', normal: { x: 0, y: 1 }, u: 0 });
        }
      }
    }
  }
  return first;
}

export function firstWall(origin: Point, destinationX: number, surfaces: readonly SurfaceSnapshot[], footRadius: number, bodyHeight: number): { surfaceId: string; x: number } | null {
  const direction = Math.sign(destinationX - origin.x);
  let first: { surfaceId: string; x: number } | null = null;
  for (const surface of surfaces) {
    const bounds = surface.bounds;
    if (!direction || surface.status !== 'valid' || !bounds || bounds.bottom <= bounds.top || origin.y <= bounds.top + 1e-6 || origin.y - bodyHeight >= bounds.bottom - 1e-6) continue;
    const x = direction > 0 ? bounds.left - footRadius : bounds.right + footRadius;
    if ((x - origin.x) * direction < -1e-6 || (destinationX - x) * direction < -1e-6) continue;
    if (!first || (x - first.x) * direction < 0) first = { surfaceId: surface.id, x };
  }
  return first;
}

export function stepBody(body: Body, surfaces: readonly SurfaceSnapshot[], dt: number, gravity: number, terminalSpeed = Number.POSITIVE_INFINITY, footRadius = 0, bodyHeight = 0): StepResult {
  let current: Body = { position: { ...body.position }, velocity: { x: body.velocity.x, y: Math.min(body.velocity.y, terminalSpeed) } };
  let remaining = dt;
  for (let contact = 0; contact < 4 && remaining > 1e-10; contact++) {
    const collision = firstCollision(current, surfaces, remaining, gravity, footRadius, bodyHeight, terminalSpeed);
    const time = collision?.time ?? remaining;
    current = {
      position: { x: current.position.x + current.velocity.x * time, y: current.position.y + displacement(current.velocity.y, gravity, time, terminalSpeed) },
      velocity: { x: current.velocity.x, y: Math.min(current.velocity.y + gravity * time, terminalSpeed) },
    };
    if (!collision) return { body: current, landing: null };
    if (collision.kind === 'land') {
      return { body: { position: current.position, velocity: { x: current.velocity.x, y: 0 } }, landing: { surfaceId: collision.surfaceId, u: collision.u, impactSpeed: current.velocity.y } };
    }
    remaining -= time;
    current.position.x += collision.normal.x * 1e-6;
    current.position.y += collision.normal.y * 1e-6;
    if (collision.kind === 'wall') current.velocity.x = 0;
    else current.velocity.y = 0;
  }
  return { body: current, landing: null };
}

export interface WalkResult {
  body: Body;
  u: number;
  distance: number;
  edge: -1 | 0 | 1;
  blocked: boolean;
}

export function stepWalk(body: Body, surface: SurfaceSnapshot, u: number, desiredSpeed: number, acceleration: number, dt: number, footRadius: number, obstacles: readonly SurfaceSnapshot[] = [], bodyHeight = 0): WalkResult {
  const length = surface.b.x - surface.a.x;
  const interval = surface.available.find((range) => u >= range.start && u <= range.end)!;
  const margin = footRadius / length;
  const direction = Math.sign(desiredSpeed - body.velocity.x);
  const accelerating = Math.min(dt, Math.abs(desiredSpeed - body.velocity.x) / acceleration);
  const velocity = body.velocity.x + direction * acceleration * accelerating;
  const distance = body.velocity.x * accelerating + direction * acceleration * accelerating ** 2 / 2 + desiredSpeed * (dt - accelerating);
  const requested = u + distance / length;
  let nextU = Math.max(interval.start + margin, Math.min(interval.end - margin, requested));
  const wall = firstWall(body.position, surface.a.x + length * nextU, obstacles, footRadius, bodyHeight);
  if (wall) nextU = (wall.x - surface.a.x) / length;
  const edge = wall ? 0 : requested > nextU + 1e-9 ? 1 : requested < nextU - 1e-9 ? -1 : 0;
  return {
    body: { position: { x: surface.a.x + length * nextU, y: surface.a.y }, velocity: { x: edge || wall ? 0 : velocity, y: 0 } },
    u: nextU,
    distance: Math.abs((nextU - u) * length),
    edge,
    blocked: Boolean(wall),
  };
}

export function planJump(origin: Point, target: Point, maxHorizontalSpeed: number, upwardSpeed: number, gravity: number): Point | null {
  const discriminant = upwardSpeed ** 2 + 2 * gravity * (target.y - origin.y);
  if (discriminant < 0) return null;
  const time = (upwardSpeed + Math.sqrt(discriminant)) / gravity;
  if (time <= 0) return null;
  const vx = (target.x - origin.x) / time;
  return Math.abs(vx) <= maxHorizontalSpeed ? { x: vx, y: -upwardSpeed } : null;
}
