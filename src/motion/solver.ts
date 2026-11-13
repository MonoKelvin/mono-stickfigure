import type { Body, Point, StepResult, SurfaceSnapshot } from '../scene/types';

function displacement(v: number, gravity: number, time: number, terminal: number): number {
  const accelerationTime = Math.min(time, Math.max(0, (terminal - v) / gravity));
  return v * accelerationTime + gravity * accelerationTime ** 2 / 2 + terminal * (time - accelerationTime);
}

export function stepBody(body: Body, surfaces: readonly SurfaceSnapshot[], dt: number, gravity: number, terminalSpeed: number, footRadius = 0): StepResult {
  const vy = Math.min(body.velocity.y, terminalSpeed);
  const next: Body = {
    position: {
      x: body.position.x + body.velocity.x * dt,
      y: body.position.y + displacement(vy, gravity, dt, terminalSpeed),
    },
    velocity: { x: body.velocity.x, y: Math.min(vy + gravity * dt, terminalSpeed) },
  };
  let firstTime = dt + 1;
  let result: StepResult = { body: next, landing: null };
  for (const surface of surfaces) {
    if (surface.status !== 'valid' || Math.abs(surface.a.y - surface.b.y) > 1e-6) continue;
    const dy = surface.a.y - body.position.y;
    if (dy < -1e-6 || next.position.y < surface.a.y) continue;
    const discriminant = vy * vy + 2 * gravity * Math.max(0, dy);
    let time = (-vy + Math.sqrt(discriminant)) / gravity;
    const accelerationTime = Math.max(0, (terminalSpeed - vy) / gravity);
    if (time > accelerationTime) {
      const distanceToTerminal = displacement(vy, gravity, accelerationTime, terminalSpeed);
      time = accelerationTime + (dy - distanceToTerminal) / terminalSpeed;
    }
    if (time < 0 || time > dt + 1e-9 || time >= firstTime || vy + gravity * time <= 0) continue;
    const x = body.position.x + body.velocity.x * time;
    const length = surface.b.x - surface.a.x;
    if (length <= 0) continue;
    const u = (x - surface.a.x) / length;
    if (!surface.available.some((interval) => x - footRadius >= surface.a.x + interval.start * length - 1e-6 && x + footRadius <= surface.a.x + interval.end * length + 1e-6)) continue;
    firstTime = time;
    result = {
      body: { position: { x, y: surface.a.y }, velocity: { x: 0, y: 0 } },
      landing: { surfaceId: surface.id, u, impactSpeed: Math.min(vy + gravity * time, terminalSpeed) },
    };
  }
  return result;
}

export function planJump(origin: Point, target: Point, maxHorizontalSpeed: number, upwardSpeed: number, gravity: number): Point | null {
  const discriminant = upwardSpeed ** 2 + 2 * gravity * (target.y - origin.y);
  if (discriminant < 0) return null;
  const time = (upwardSpeed + Math.sqrt(discriminant)) / gravity;
  if (time <= 0) return null;
  const vx = (target.x - origin.x) / time;
  return Math.abs(vx) <= maxHorizontalSpeed ? { x: vx, y: -upwardSpeed } : null;
}
