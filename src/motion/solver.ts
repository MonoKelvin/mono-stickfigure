import type { Body, ClimbContact, Interval, Point, StepResult, SurfaceBounds, SurfaceSnapshot } from '../scene/types';

interface IndexedSurface {
  surface: SurfaceSnapshot;
  order: number;
  bounds: SurfaceBounds;
}
interface CollisionNode {
  bounds: SurfaceBounds;
  entries?: IndexedSurface[];
  children?: readonly CollisionNode[];
}

function overlaps(a: SurfaceBounds, b: SurfaceBounds): boolean {
  return a.left <= b.right && a.right >= b.left && a.top <= b.bottom && a.bottom >= b.top;
}

function union(a: SurfaceBounds, b: SurfaceBounds): SurfaceBounds {
  return { left: Math.min(a.left, b.left), right: Math.max(a.right, b.right), top: Math.min(a.top, b.top), bottom: Math.max(a.bottom, b.bottom) };
}

function* collisionTree(surfaces: readonly SurfaceSnapshot[]): Generator<void, CollisionNode> {
  const heap: { entry: IndexedSurface; center: number }[] = [];
  let extent = { left: Infinity, right: -Infinity, top: Infinity, bottom: -Infinity };
  const entries: IndexedSurface[] = [];
  for (let order = 0; order < surfaces.length; order++) {
    const surface = surfaces[order]!;
    const { a, b, bounds } = surface;
    let box = { left: Math.min(a.x, b.x, bounds?.left ?? Infinity, bounds?.right ?? Infinity), right: Math.max(a.x, b.x, bounds?.right ?? -Infinity, bounds?.left ?? -Infinity),
      top: Math.min(a.y, b.y, bounds?.top ?? Infinity), bottom: Math.max(a.y, b.y, bounds?.bottom ?? -Infinity) };
    for (const range of surface.available) {
      for (const u of [range.start, range.end]) {
        const x = a.x + u * (b.x - a.x), y = a.y + u * (b.y - a.y);
        box = union(box, { left: x, right: x, top: y, bottom: y });
      }
    }
    if (![box.left, box.right, box.top, box.bottom].every(Number.isFinite)) box = { left: -Infinity, right: Infinity, top: -Infinity, bottom: Infinity };
    extent = union(extent, box);
    entries.push({ surface, order, bounds: box });
    if (order % 8 === 7) yield;
  }
  const horizontal = extent.right - extent.left >= extent.bottom - extent.top;
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!;
    const center = horizontal ? (entry.bounds.left + entry.bounds.right) / 2 : (entry.bounds.top + entry.bounds.bottom) / 2;
    const item = { entry, center: Number.isFinite(center) ? center : 0 };
    heap.push(item);
    let index = heap.length - 1;
    while (index > 0) {
      const parent = (index - 1) >> 1;
      if (heap[parent]!.center <= item.center) break;
      heap[index] = heap[parent]!;
      index = parent;
    }
    heap[index] = item;
    if (i % 8 === 7) yield;
  }
  const sorted: IndexedSurface[] = [];
  while (heap.length) {
    sorted.push(heap[0]!.entry);
    const item = heap.pop()!;
    if (heap.length) {
      let index = 0;
      while (index * 2 + 1 < heap.length) {
        let child = index * 2 + 1;
        if (child + 1 < heap.length && heap[child + 1]!.center < heap[child]!.center) child++;
        if (heap[child]!.center >= item.center) break;
        heap[index] = heap[child]!;
        index = child;
      }
      heap[index] = item;
    }
    if (sorted.length % 8 === 0) yield;
  }
  function* build(start: number, end: number): Generator<void, CollisionNode> {
    if (end - start <= 8) {
      const entries = sorted.slice(start, end);
      let bounds = { left: Infinity, right: -Infinity, top: Infinity, bottom: -Infinity };
      for (const entry of entries) bounds = union(bounds, entry.bounds);
      yield;
      return { bounds, entries };
    }
    const middle = (start + end) >> 1;
    const left = yield* build(start, middle), right = yield* build(middle, end);
    yield;
    return { bounds: union(left.bounds, right.bounds), children: [left, right] };
  }
  return yield* build(0, sorted.length);
}

export class SurfaceCollisionIndex {
  private readonly tree: CollisionNode;
  constructor(readonly surfaces: readonly SurfaceSnapshot[], tree?: CollisionNode) {
    if (tree) this.tree = tree;
    else {
      const build = collisionTree(surfaces);
      let result = build.next();
      while (!result.done) result = build.next();
      this.tree = result.value;
    }
  }

  static *build(surfaces: readonly SurfaceSnapshot[]): Generator<void, SurfaceCollisionIndex> {
    return new SurfaceCollisionIndex(surfaces, yield* collisionTree(surfaces));
  }

  query(bounds: SurfaceBounds): readonly SurfaceSnapshot[] {
    const root = this.tree.bounds;
    if (bounds.left <= root.left && bounds.right >= root.right && bounds.top <= root.top && bounds.bottom >= root.bottom) return this.surfaces;
    const entries: IndexedSurface[] = [];
    const visit = (node: CollisionNode) => {
      if (!overlaps(node.bounds, bounds)) return;
      if (node.entries) {
        for (const entry of node.entries) if (overlaps(entry.bounds, bounds)) entries.push(entry);
      } else for (const child of node.children!) visit(child);
    };
    visit(this.tree);
    if (entries.length > this.surfaces.length / 2) return this.surfaces;
    return entries.sort((a, b) => a.order - b.order).map((entry) => entry.surface);
  }
}

function sweptBounds(body: Body, duration: number, gravity: number, terminal: number, radius: number, height: number): SurfaceBounds | null {
  const vy = Math.min(body.velocity.y, terminal);
  if (!(gravity > 0) || !(terminal > 0) || duration < 0 || ![body.position.x, body.position.y, body.velocity.x, vy, gravity, radius, height].every(Number.isFinite)) return null;
  const time = duration + 1e-9;
  const apexTime = Math.min(time, Math.max(0, -vy / gravity));
  const lowY = body.position.y + displacement(vy, gravity, apexTime, terminal);
  const endY = time === Infinity ? Infinity : body.position.y + displacement(vy, gravity, time, terminal);
  const endX = body.velocity.x === 0 ? body.position.x : body.position.x + body.velocity.x * time;
  const margin = 1e-6 + Math.abs(body.velocity.x) * 1e-9;
  const yMargin = 1e-6 + Math.abs(vy) * 1e-9 + gravity * 1e-18 / 2;
  return { left: Math.min(body.position.x, endX) - Math.abs(radius) - margin, right: Math.max(body.position.x, endX) + Math.abs(radius) + margin,
    top: Math.min(body.position.y, lowY, endY) - Math.max(0, height) - yMargin, bottom: Math.max(body.position.y, endY) + Math.max(0, -height) + yMargin };
}

export function displacement(v: number, gravity: number, time: number, terminal = Infinity): number {
  const accelerationTime = Math.min(time, Math.max(0, (terminal - v) / gravity));
  const accelerated = v * accelerationTime + gravity * accelerationTime ** 2 / 2;
  return accelerationTime === time ? accelerated : accelerated + terminal * (time - accelerationTime);
}

export interface FlightCollision {
  surfaceId: string;
  time: number;
  kind: 'land' | 'wall' | 'ceiling' | 'grab';
  normal: Point;
  u: number;
}

export function crossingTime(vy: number, dy: number, gravity: number, terminal = Infinity, ascending = false): number | null {
  const discriminant = vy * vy + 2 * gravity * dy;
  if (discriminant < 0) return null;
  let time = (-vy + (ascending ? -1 : 1) * Math.sqrt(discriminant)) / gravity;
  const accelerationTime = Math.max(0, (terminal - vy) / gravity);
  if (!ascending && time > accelerationTime) time = accelerationTime + (dy - displacement(vy, gravity, accelerationTime, terminal)) / terminal;
  return time >= -1e-9 ? Math.max(0, time) : null;
}

function climbNormal(surface: SurfaceSnapshot): Point {
  const normal = surface.normal!;
  const length = Math.hypot(normal.x, normal.y);
  return { x: normal.x / length, y: normal.y / length };
}

export function climbRoot(surface: SurfaceSnapshot, u: number, height: number): Point {
  const normal = climbNormal(surface);
  return { x: surface.a.x + (surface.b.x - surface.a.x) * u + normal.x * height * 0.26,
    y: surface.a.y + (surface.b.y - surface.a.y) * u + normal.y * height * 0.26 };
}

export function climbInterval(surface: SurfaceSnapshot, u: number, height: number): Interval | null {
  if (surface.mode !== 'climb' || !surface.normal || surface.status !== 'valid') return null;
  const length = Math.hypot(surface.b.x - surface.a.x, surface.b.y - surface.a.y);
  if (length < height * 2 || Math.atan2(Math.abs(surface.b.y - surface.a.y), Math.abs(surface.b.x - surface.a.x)) <= 80 * Math.PI / 180 + 1e-10) return null;
  for (const range of surface.available) {
    if ((range.end - range.start) * length < height * 2) continue;
    const start = range.start + height * 0.75 / length, end = range.end - height * 0.12 / length;
    if (u >= start - 1e-6 && u <= end + 1e-6) return { start, end };
  }
  return null;
}

function grabCollision(body: Body, surface: SurfaceSnapshot, duration: number, gravity: number, terminal: number, height: number): FlightCollision | null {
  if (surface.mode !== 'climb' || !surface.normal || height <= 0) return null;
  const n = climbNormal(surface);
  const vy = Math.min(body.velocity.y, terminal), vx = body.velocity.x;
  const offset = height * 0.26;
  const distance = n.x * (body.position.x - surface.a.x) + n.y * (body.position.y - surface.a.y) - offset;
  if (distance < -1e-6) return null;
  const cap = Math.max(0, (terminal - vy) / gravity);
  const roots: number[] = [];
  const a = n.y * gravity / 2, b = n.x * vx + n.y * vy;
  if (Math.abs(a) < 1e-12) {
    if (b < -1e-8) roots.push(-distance / b);
  } else {
    const disc = b * b - 4 * a * distance;
    if (disc >= 0) {
      const root = Math.sqrt(disc);
      roots.push((-b - root) / (2 * a), (-b + root) / (2 * a));
    }
  }
  if (Number.isFinite(cap)) {
    const atCap = distance + n.x * vx * cap + n.y * displacement(vy, gravity, cap, terminal);
    const slope = n.x * vx + n.y * terminal;
    if (slope < -1e-8) roots.push(cap - atCap / slope);
  }
  roots.sort((a, b) => a - b);
  for (const rawTime of roots) {
    const time = Math.max(0, rawTime);
    if (rawTime < -1e-9 || time > duration + 1e-9) continue;
    if (time <= cap + 1e-9 && n.x * vx + n.y * (vy + gravity * time) >= -1e-8) continue;
    if (time > cap + 1e-9 && n.x * vx + n.y * terminal >= -1e-8) continue;
    const x = body.position.x + vx * time, y = body.position.y + displacement(vy, gravity, time, terminal);
    if (Math.abs(n.x * (x - surface.a.x) + n.y * (y - surface.a.y) - offset) > 1e-5) continue;
    const dx = surface.b.x - surface.a.x, dy = surface.b.y - surface.a.y;
    const u = ((x - surface.a.x - n.x * offset) * dx + (y - surface.a.y - n.y * offset) * dy) / (dx * dx + dy * dy);
    if (!climbInterval(surface, u, height)) continue;
    return { surfaceId: surface.id, time, kind: 'grab', normal: n, u };
  }
  return null;
}

export function firstCollision(body: Body, surfaces: readonly SurfaceSnapshot[], duration: number, gravity: number, footRadius: number, bodyHeight: number, terminalSpeed = Infinity, ignoredId?: string, index?: SurfaceCollisionIndex, climbTargetId?: string): FlightCollision | null {
  const vy = Math.min(body.velocity.y, terminalSpeed);
  let first: FlightCollision | null = null;
  const consider = (collision: FlightCollision) => {
    const sameWall = collision.kind === 'grab' && first?.kind === 'wall' && surfaces.find(s => s.id === first!.surfaceId)?.sourceId === surfaces.find(s => s.id === collision.surfaceId)?.sourceId;
    if (collision.time <= duration + 1e-9 && (!first || collision.time < first.time - 1e-9 || sameWall && Math.abs(collision.time - first.time) <= 1e-9)) first = collision;
  };
  const bounds = index?.surfaces === surfaces ? sweptBounds(body, duration, gravity, terminalSpeed, Math.max(footRadius, climbTargetId ? bodyHeight * 0.26 : 0), bodyHeight) : null;
  for (const surface of bounds ? index!.query(bounds) : surfaces) {
    if (surface.status !== 'valid' || surface.id === ignoredId) continue;
    if (surface.id === climbTargetId) {
      const grab = grabCollision(body, surface, duration, gravity, terminalSpeed, bodyHeight);
      if (grab) consider(grab);
    }
    if (surface.mode !== 'climb' && Math.abs(surface.a.y - surface.b.y) <= 1e-6) {
      const time = crossingTime(vy, surface.a.y - body.position.y, gravity, terminalSpeed);
      const width = surface.b.x - surface.a.x;
      if (time !== null && time <= duration + 1e-9 && vy + gravity * time > 0 && width > 0) {
        const x = body.position.x + body.velocity.x * time;
        if (surface.available.some((range) => x - footRadius >= surface.a.x + range.start * width - 1e-6 && x + footRadius <= surface.a.x + range.end * width + 1e-6)) consider({ surfaceId: surface.id, time, kind: 'land', normal: { x: 0, y: -1 }, u: (x - surface.a.x) / width });
      }
    }
    const solid = surface.bounds;
    if (!solid || solid.right <= solid.left || solid.bottom <= solid.top) continue;
    const vx = body.velocity.x;
    const edge = vx > 0 ? solid.left - footRadius : solid.right + footRadius;
    if (vx && (vx > 0 ? body.position.x <= edge + 1e-6 : body.position.x >= edge - 1e-6)) {
      const time = (edge - body.position.x) / vx;
      if (time >= -1e-9 && time <= duration + 1e-9) {
        const y = body.position.y + displacement(vy, gravity, Math.max(0, time), terminalSpeed);
        if (y > solid.top + 1e-6 && y - bodyHeight < solid.bottom - 1e-6) consider({ surfaceId: surface.id, time: Math.max(0, time), kind: 'wall', normal: { x: vx > 0 ? -1 : 1, y: 0 }, u: 0 });
      }
    }
    if (vy < 0 && body.position.y - bodyHeight >= solid.bottom - 1e-6) {
      const time = crossingTime(vy, solid.bottom + bodyHeight - body.position.y, gravity, terminalSpeed, true);
      if (time !== null && time <= duration + 1e-9) {
        const x = body.position.x + vx * time;
        if (x + footRadius > solid.left + 1e-6 && x - footRadius < solid.right - 1e-6) consider({ surfaceId: surface.id, time, kind: 'ceiling', normal: { x: 0, y: 1 }, u: 0 });
      }
    }
  }
  return first;
}

export function firstWall(origin: Point, destinationX: number, surfaces: readonly SurfaceSnapshot[], footRadius: number, bodyHeight: number, index?: SurfaceCollisionIndex): { surfaceId: string; x: number } | null {
  const direction = Math.sign(destinationX - origin.x);
  if (!direction) return null;
  const query = { left: Math.min(origin.x, destinationX) - Math.abs(footRadius) - 1e-6, right: Math.max(origin.x, destinationX) + Math.abs(footRadius) + 1e-6,
    top: origin.y - Math.max(0, bodyHeight) - 1e-6, bottom: origin.y + Math.max(0, -bodyHeight) + 1e-6 };
  const candidates = index?.surfaces === surfaces && Object.values(query).every(Number.isFinite) ? index.query(query) : surfaces;
  let first: { surfaceId: string; x: number } | null = null;
  for (const surface of candidates) {
    const bounds = surface.bounds;
    if (surface.status !== 'valid' || !bounds || bounds.bottom <= bounds.top || origin.y <= bounds.top + 1e-6 || origin.y - bodyHeight >= bounds.bottom - 1e-6) continue;
    const x = direction > 0 ? bounds.left - footRadius : bounds.right + footRadius;
    if ((x - origin.x) * direction < -1e-6 || (destinationX - x) * direction < -1e-6) continue;
    if (!first || (x - first.x) * direction < 0) first = { surfaceId: surface.id, x };
  }
  return first;
}

export interface FlightStepResult extends StepResult {
  climb: ClimbContact | null;
  remainingTime: number;
  contacts: readonly FlightCollision[];
  grabVelocity: Point | null;
}

export function stepFlight(body: Body, surfaces: readonly SurfaceSnapshot[], dt: number, gravity: number, terminalSpeed = Infinity, footRadius = 0, bodyHeight = 0, climbTargetId?: string): FlightStepResult {
  let current: Body = { position: { ...body.position }, velocity: { x: body.velocity.x, y: Math.min(body.velocity.y, terminalSpeed) } };
  let remaining = dt;
  const contacts: FlightCollision[] = [];
  for (let contact = 0; contact < 4 && remaining > 1e-10; contact++) {
    const collision = firstCollision(current, surfaces, remaining, gravity, footRadius, bodyHeight, terminalSpeed, undefined, undefined, climbTargetId);
    const time = collision?.time ?? remaining;
    current = { position: { x: current.position.x + current.velocity.x * time, y: current.position.y + displacement(current.velocity.y, gravity, time, terminalSpeed) }, velocity: { x: current.velocity.x, y: Math.min(current.velocity.y + gravity * time, terminalSpeed) } };
    if (!collision) return { body: current, landing: null, climb: null, remainingTime: 0, contacts, grabVelocity: null };
    contacts.push(collision);
    remaining -= time;
    if (collision.kind === 'land') return { body: { position: current.position, velocity: { x: current.velocity.x, y: 0 } }, landing: { surfaceId: collision.surfaceId, u: collision.u, impactSpeed: current.velocity.y }, climb: null, remainingTime: remaining, contacts, grabVelocity: null };
    if (collision.kind === 'grab') {
      const surface = surfaces.find(s => s.id === collision.surfaceId)!;
      return { body: { position: current.position, velocity: { x: 0, y: 0 } }, landing: null, climb: { surfaceId: surface.id, sourceRevision: surface.sourceRevision, u: collision.u, normal: collision.normal }, remainingTime: remaining, contacts, grabVelocity: { ...current.velocity } };
    }
    current.position.x += collision.normal.x * 1e-6;
    current.position.y += collision.normal.y * 1e-6;
    if (collision.kind === 'wall') current.velocity.x = 0;
    else current.velocity.y = 0;
  }
  return { body: current, landing: null, climb: null, remainingTime: 0, contacts, grabVelocity: null };
}

export function stepBody(body: Body, surfaces: readonly SurfaceSnapshot[], dt: number, gravity: number, terminalSpeed = Infinity, footRadius = 0, bodyHeight = 0): StepResult {
  const result = stepFlight(body, surfaces, dt, gravity, terminalSpeed, footRadius, bodyHeight);
  return { body: result.body, landing: result.landing };
}

export interface WalkResult {
  body: Body;
  u: number;
  distance: number;
  edge: -1 | 0 | 1;
  blocked: boolean;
}

export function stepClimb(body: Body, surface: SurfaceSnapshot, u: number, desiredSpeed: number, acceleration: number, dt: number, height: number): Omit<WalkResult, 'blocked'> {
  const interval = climbInterval(surface, u, height)!;
  const dx = surface.b.x - surface.a.x, dy = surface.b.y - surface.a.y, length = Math.hypot(dx, dy);
  const speed = (body.velocity.x * dx + body.velocity.y * dy) / length;
  const direction = Math.sign(desiredSpeed - speed);
  const accelerating = Math.min(dt, Math.abs(desiredSpeed - speed) / acceleration);
  const nextSpeed = speed + direction * acceleration * accelerating;
  const distance = speed * accelerating + direction * acceleration * accelerating ** 2 / 2 + desiredSpeed * (dt - accelerating);
  const requested = u + distance / length;
  const nextU = Math.max(interval.start, Math.min(interval.end, requested));
  const edge = requested > nextU + 1e-9 ? 1 : requested < nextU - 1e-9 ? -1 : 0;
  return { body: { position: climbRoot(surface, nextU, height), velocity: edge ? { x: 0, y: 0 } : { x: dx / length * nextSpeed, y: dy / length * nextSpeed } }, u: nextU, distance: Math.abs(nextU - u) * length, edge };
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
  return { body: { position: { x: surface.a.x + length * nextU, y: surface.a.y }, velocity: { x: edge || wall ? 0 : velocity, y: 0 } }, u: nextU, distance: Math.abs((nextU - u) * length), edge, blocked: Boolean(wall) };
}

export function planJump(origin: Point, target: Point, maxHorizontalSpeed: number, upwardSpeed: number, gravity: number, maxFallSpeed = Infinity): Point | null {
  const time = crossingTime(-upwardSpeed, target.y - origin.y, gravity, maxFallSpeed);
  if (time === null || time <= 0) return null;
  const vx = (target.x - origin.x) / time;
  return Math.abs(vx) <= maxHorizontalSpeed ? { x: vx, y: -upwardSpeed } : null;
}
