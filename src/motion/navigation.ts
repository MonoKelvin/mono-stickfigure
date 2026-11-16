import { climbInterval, climbRoot, crossingTime, firstCollision, firstWall, planJump, SurfaceCollisionIndex } from './solver';
import type { Anchor, Point, SurfaceSnapshot } from '../scene/types';

export interface NavigationTarget {
  surfaceId: string;
  u: number;
}

export interface TakeoffPlan {
  startU: number;
  launchU: number;
  velocity: Point;
  long: boolean;
}

export interface NavigationStep extends NavigationTarget {
  kind: 'walk' | 'jump' | 'drop' | 'climb' | 'grab' | 'climb-jump';
  sourceRevision: number;
  takeoff?: TakeoffPlan;
}

export interface NavigationPhysics {
  gravity: number;
  upwardSpeed: number;
  maxHorizontalSpeed: number;
  maxFallSpeed?: number;
  climbSpeed?: number;
  grabDuration?: number;
  climbDestination?: string;
  longUpwardSpeed?: number;
  longHorizontalSpeed?: number;
  acceleration?: number;
  anticipation?: number;
  walkSpeed: number;
  footRadius: number;
  bodyHeight?: number;
}

interface Node {
  key: string;
  surface: SurfaceSnapshot;
  startU: number;
  endU: number;
  u: number;
  left: number;
  right: number;
  center: Point;
}

interface Edge {
  departure: number;
  destination: number;
  kind: NavigationStep['kind'];
  cost: number;
  takeoff?: TakeoffPlan;
}

export interface ReachableRoute {
  target: NavigationTarget;
  route: NavigationStep[];
  cost: number;
}

export function firstLanding(origin: Point, velocity: Point, surfaces: readonly SurfaceSnapshot[], gravity: number, footRadius: number, ignoredId?: string, bodyHeight = 0, index?: SurfaceCollisionIndex, maxFallSpeed = Infinity): { surfaceId: string; u: number; time: number } | null {
  const collision = firstCollision({ position: origin, velocity }, surfaces, Infinity, gravity, footRadius, bodyHeight, maxFallSpeed, ignoredId, index);
  return collision?.kind === 'land' ? { surfaceId: collision.surfaceId, u: collision.u, time: collision.time } : null;
}

function contact(origin: Point, velocity: Point, surfaces: readonly SurfaceSnapshot[], physics: NavigationPhysics, target: SurfaceSnapshot, index?: SurfaceCollisionIndex) {
  return firstCollision({ position: origin, velocity }, surfaces, Infinity, physics.gravity, physics.footRadius, physics.bodyHeight ?? 0, physics.maxFallSpeed ?? Infinity, undefined, index, target.mode === 'climb' ? target.id : undefined);
}

function velocities(origin: Point, target: Point, limit: number, upward: number, physics: NavigationPhysics, grab: boolean): Point[] {
  if (!grab) {
    const velocity = planJump(origin, target, limit, upward, physics.gravity, physics.maxFallSpeed ?? Infinity);
    return velocity ? [velocity] : [];
  }
  const times = [crossingTime(-upward, target.y - origin.y, physics.gravity, physics.maxFallSpeed ?? Infinity, true), crossingTime(-upward, target.y - origin.y, physics.gravity, physics.maxFallSpeed ?? Infinity)];
  return times.flatMap(time => time !== null && time > 1e-9 && Math.abs((target.x - origin.x) / time) <= limit ? [{ x: (target.x - origin.x) / time, y: -upward }] : []);
}

export function planTakeoff(source: SurfaceSnapshot, u: number, target: Point, physics: NavigationPhysics, long: boolean, surfaces: readonly SurfaceSnapshot[], targetId: string, index?: SurfaceCollisionIndex): TakeoffPlan | null {
  const destination = surfaces.find(surface => surface.id === targetId);
  if (!destination || source.mode === 'climb') return null;
  const width = source.b.x - source.a.x;
  const interval = source.available.find((range) => u >= range.start && u <= range.end);
  if (!interval || width <= 0) return null;
  const left = source.a.x + interval.start * width + physics.footRadius;
  const right = source.a.x + interval.end * width - physics.footRadius;
  if (right < left) return null;
  const upwardSpeed = long ? physics.longUpwardSpeed ?? physics.upwardSpeed : physics.upwardSpeed;
  const limit = long ? physics.longHorizontalSpeed ?? physics.maxHorizontalSpeed : physics.maxHorizontalSpeed;
  const acceleration = physics.acceleration ?? limit * 4;
  const preferred = Math.max(left, Math.min(right, source.a.x + u * width));
  const nearest = Math.max(left, Math.min(right, target.x));
  for (const launchX of new Set([preferred, nearest, left, right])) {
    const origin = { x: launchX, y: source.a.y };
    for (const velocity of velocities(origin, target, limit, upwardSpeed, physics, destination.mode === 'climb')) {
      const speed = Math.abs(velocity.x);
      const distance = speed ** 2 / (2 * acceleration) + speed * (physics.anticipation ?? 0.16);
      const startX = launchX - Math.sign(velocity.x) * distance;
      if (startX < left - 1e-6 || startX > right + 1e-6) continue;
      if (firstWall({ x: startX, y: source.a.y }, launchX, surfaces, physics.footRadius, physics.bodyHeight ?? 0, index)) continue;
      const hit = contact(origin, velocity, surfaces, physics, destination, index);
      if (!hit || hit.surfaceId !== targetId || hit.kind !== (destination.mode === 'climb' ? 'grab' : 'land')) continue;
      const point = destination.mode === 'climb' ? climbRoot(destination, hit.u, physics.bodyHeight ?? 0) : { x: destination.a.x + (destination.b.x - destination.a.x) * hit.u, y: destination.a.y };
      if (Math.hypot(point.x - target.x, point.y - target.y) > Math.max(physics.footRadius, 1e-6)) continue;
      return { startU: (startX - source.a.x) / width, launchU: (launchX - source.a.x) / width, velocity, long };
    }
  }
  return null;
}

function sameRange(from: Node, to: Node): boolean {
  return from.surface.id === to.surface.id && from.startU === to.startU && from.endU === to.endU;
}

function transition(from: Node, to: Node, surfaces: readonly SurfaceSnapshot[], physics: NavigationPhysics, index: SurfaceCollisionIndex): Edge | null {
  const sourceClimb = from.surface.mode === 'climb', targetClimb = to.surface.mode === 'climb';
  if (sameRange(from, to)) {
    if (!sourceClimb && firstWall(from.center, to.center.x, surfaces, physics.footRadius, physics.bodyHeight ?? 0, index)) return null;
    return { departure: from.u, destination: to.u, kind: sourceClimb ? 'climb' : 'walk', cost: Math.hypot(to.center.x - from.center.x, to.center.y - from.center.y) / (sourceClimb ? physics.climbSpeed ?? physics.walkSpeed : physics.walkSpeed) };
  }
  if (sourceClimb) {
    if (targetClimb || from.surface.id === physics.climbDestination) return null;
    const targets = new Set([Math.max(to.left, Math.min(to.right, from.center.x)), to.center.x]);
    for (const end of targets) {
      if (firstWall(to.center, end, surfaces, physics.footRadius, physics.bodyHeight ?? 0, index)) continue;
      for (const long of [false, true]) {
        if (long && (!physics.longUpwardSpeed || !physics.longHorizontalSpeed)) continue;
        const velocity = planJump(from.center, { x: end, y: to.center.y }, long ? physics.longHorizontalSpeed! : physics.maxHorizontalSpeed, long ? physics.longUpwardSpeed! : physics.upwardSpeed, physics.gravity, physics.maxFallSpeed ?? Infinity);
        if (!velocity) continue;
        const landing = contact(from.center, velocity, surfaces, physics, to.surface, index);
        if (landing?.kind !== 'land' || landing.surfaceId !== to.surface.id || landing.u < to.startU - 1e-6 || landing.u > to.endU + 1e-6) continue;
        const x = to.surface.a.x + (to.surface.b.x - to.surface.a.x) * landing.u;
        return { departure: from.u, destination: landing.u, kind: 'climb-jump', cost: landing.time + Math.abs(x - to.center.x) / physics.walkSpeed,
          takeoff: { startU: from.u, launchU: from.u, velocity, long } };
      }
    }
    return null;
  }
  if (targetClimb) {
    for (const long of [false, true]) {
      if (long && (!physics.longUpwardSpeed || !physics.longHorizontalSpeed)) continue;
      const takeoff = planTakeoff(from.surface, from.u, to.center, physics, long, surfaces, to.surface.id, index);
      if (!takeoff) continue;
      const startX = from.surface.a.x + (from.surface.b.x - from.surface.a.x) * takeoff.startU;
      if (takeoff.startU < from.startU - 1e-6 || takeoff.startU > from.endU + 1e-6 || firstWall(from.center, startX, surfaces, physics.footRadius, physics.bodyHeight ?? 0, index)) continue;
      const launch = { x: from.surface.a.x + (from.surface.b.x - from.surface.a.x) * takeoff.launchU, y: from.surface.a.y };
      const hit = contact(launch, takeoff.velocity, surfaces, physics, to.surface, index);
      if (hit?.kind !== 'grab' || hit.surfaceId !== to.surface.id) continue;
      return { departure: takeoff.startU, destination: hit.u, kind: 'grab', takeoff,
        cost: Math.abs(from.center.x - startX) / physics.walkSpeed + Math.abs(takeoff.velocity.x) / (physics.acceleration ?? physics.maxHorizontalSpeed * 4) + (physics.anticipation ?? 0.16) + hit.time + (physics.grabDuration ?? 0) + Math.hypot(climbRoot(to.surface, hit.u, physics.bodyHeight ?? 0).x - to.center.x, climbRoot(to.surface, hit.u, physics.bodyHeight ?? 0).y - to.center.y) / (physics.climbSpeed ?? physics.walkSpeed) };
    }
    return null;
  }
  const overlapLeft = Math.max(from.left, to.left), overlapRight = Math.min(from.right, to.right);
  const overlap = overlapLeft <= overlapRight;
  const start = overlap ? (overlapLeft + overlapRight) / 2 : to.left > from.right ? from.right : from.left;
  const inset = Math.min((to.right - to.left) / 2, physics.footRadius);
  const end = overlap ? start : to.left > from.right ? to.left + inset : to.right - inset;
  if (firstWall(to.center, end, surfaces, physics.footRadius, physics.bodyHeight ?? 0, index)) return null;
  if (overlap && to.center.y > from.center.y + 1) {
    if (firstWall(from.center, start, surfaces, physics.footRadius, physics.bodyHeight ?? 0, index)) return null;
    const landing = firstLanding({ x: start, y: from.center.y }, { x: 0, y: 0 }, surfaces, physics.gravity, physics.footRadius, from.surface.id, physics.bodyHeight ?? 0, index, physics.maxFallSpeed ?? Infinity);
    if (landing?.surfaceId === to.surface.id) return { departure: (start - from.surface.a.x) / (from.surface.b.x - from.surface.a.x), destination: landing.u, kind: 'drop',
      cost: Math.abs(from.center.x - start) / physics.walkSpeed + landing.time + Math.abs(end - to.center.x) / physics.walkSpeed };
  }
  const sourceU = (start - from.surface.a.x) / (from.surface.b.x - from.surface.a.x);
  for (const long of [false, true]) {
    if (long && (!physics.longUpwardSpeed || !physics.longHorizontalSpeed)) continue;
    const takeoff = planTakeoff(from.surface, sourceU, { x: end, y: to.center.y }, physics, long, surfaces, to.surface.id, index);
    if (!takeoff) continue;
    const launchX = from.surface.a.x + (from.surface.b.x - from.surface.a.x) * takeoff.launchU;
    const startX = from.surface.a.x + (from.surface.b.x - from.surface.a.x) * takeoff.startU;
    if (startX < from.left - 1e-6 || startX > from.right + 1e-6 || firstWall(from.center, startX, surfaces, physics.footRadius, physics.bodyHeight ?? 0, index)) continue;
    const landing = firstLanding({ x: launchX, y: from.center.y }, takeoff.velocity, surfaces, physics.gravity, physics.footRadius, undefined, physics.bodyHeight ?? 0, index, physics.maxFallSpeed ?? Infinity);
    if (!landing || landing.surfaceId !== to.surface.id) continue;
    const x = to.surface.a.x + (to.surface.b.x - to.surface.a.x) * landing.u;
    if (x < to.left - 1e-6 || x > to.right + 1e-6) continue;
    return { departure: takeoff.startU, destination: landing.u, kind: 'jump', takeoff,
      cost: Math.abs(from.center.x - startX) / physics.walkSpeed + Math.abs(takeoff.velocity.x) / (physics.acceleration ?? physics.maxHorizontalSpeed * 4) + (physics.anticipation ?? 0.16) + landing.time + Math.abs(x - to.center.x) / physics.walkSpeed };
  }
  return null;
}

function node(surface: SurfaceSnapshot, index: number, startU: number, endU: number, u: number, height: number, suffix = ''): Node {
  const center = surface.mode === 'climb' ? climbRoot(surface, u, height) : { x: surface.a.x + (surface.b.x - surface.a.x) * u, y: surface.a.y };
  return { key: `${surface.id}:${index}${suffix}`, surface, startU, endU, u, left: surface.a.x + (surface.b.x - surface.a.x) * startU, right: surface.a.x + (surface.b.x - surface.a.x) * endU, center };
}

function* surfaceNodes(surface: SurfaceSnapshot, physics: NavigationPhysics): Generator<Node> {
  if (surface.status !== 'valid') return;
  if (surface.mode !== 'climb' && Math.abs(surface.a.y - surface.b.y) > 1e-6) return;
  const height = physics.bodyHeight ?? 0;
  for (let i = 0; i < surface.available.length; i++) {
    const range = surface.available[i]!;
    if (surface.mode === 'climb') {
      if (height <= 0) continue;
      const middle = (range.start + range.end) / 2;
      const interval = climbInterval(surface, middle, height);
      if (!interval) continue;
      const positions = [interval.start, (interval.start + interval.end) / 2, interval.end];
      for (let site = 0; site < positions.length; site++) yield node(surface, i, interval.start, interval.end, positions[site]!, height, `:${site}`);
    } else {
      const width = surface.b.x - surface.a.x;
      if (width <= 0) continue;
      const start = range.start + physics.footRadius / width, end = range.end - physics.footRadius / width;
      if (end >= start) yield node(surface, i, start, end, (start + end) / 2, height);
    }
  }
}

function endpoint(surface: SurfaceSnapshot | undefined, target: NavigationTarget, physics: NavigationPhysics, key: string): Node | null {
  if (!surface) return null;
  for (const candidate of surfaceNodes(surface, physics)) {
    if (target.u >= candidate.startU - 1e-6 && target.u <= candidate.endU + 1e-6) return { ...candidate, key, u: target.u, center: surface.mode === 'climb' ? climbRoot(surface, target.u, physics.bodyHeight ?? 0) : { x: surface.a.x + (surface.b.x - surface.a.x) * target.u, y: surface.a.y } };
  }
  return null;
}

function assemble(start: Node, goal: Node, target: NavigationTarget, previous: Map<string, { node: Node; edge: Edge }>): NavigationStep[] {
  const edges: { from: Node; to: Node; edge: Edge }[] = [];
  let node = goal;
  while (node !== start) {
    const before = previous.get(node.key)!;
    edges.push({ from: before.node, to: node, edge: before.edge });
    node = before.node;
  }
  const steps: NavigationStep[] = [];
  for (const { from, to, edge } of edges.reverse()) {
    if (edge.kind !== 'walk' && edge.kind !== 'climb') steps.push({ kind: from.surface.mode === 'climb' ? 'climb' : 'walk', surfaceId: from.surface.id, u: edge.departure, sourceRevision: from.surface.sourceRevision });
    steps.push({ kind: edge.kind, surfaceId: to.surface.id, u: edge.destination, sourceRevision: to.surface.sourceRevision, ...(edge.takeoff ? { takeoff: edge.takeoff } : {}) });
  }
  const last = steps.at(-1);
  if (last?.surfaceId === goal.surface.id && Math.abs(last.u - target.u) <= 1e-9 && (last.kind === 'walk' || last.kind === 'climb')) return steps;
  return [...steps, { kind: goal.surface.mode === 'climb' ? 'climb' : 'walk', ...target, sourceRevision: goal.surface.sourceRevision }];
}

export interface PlanningResult {
  status: 'pending' | 'found' | 'unreachable';
  route: NavigationStep[] | null;
  candidates: number;
  expanded: number;
  checkedEdges: number;
  elapsedMs: number;
}

export class PlanningJob {
  private readonly task: Generator<void>;
  private result: PlanningResult = { status: 'pending', route: null, candidates: 0, expanded: 0, checkedEdges: 0, elapsedMs: 0 };
  private reachable: ReachableRoute[] = [];

  constructor(readonly surfaces: readonly SurfaceSnapshot[], readonly anchor: Anchor, readonly target: NavigationTarget | undefined, readonly physics: NavigationPhysics) {
    this.task = this.search();
  }

  advance(budgetMs: number, workLimit = 32): PlanningResult {
    if (this.result.status !== 'pending' || budgetMs <= 0 || workLimit <= 0) return { ...this.result };
    const start = performance.now();
    for (let work = 0; work < workLimit && performance.now() - start < budgetMs; work++) {
      const result = this.task.next();
      if (result.done) break;
    }
    this.result.elapsedMs += performance.now() - start;
    return { ...this.result };
  }

  reachableRoutes(): ReachableRoute[] {
    return this.reachable;
  }

  private *search(): Generator<void> {
    let source: SurfaceSnapshot | undefined, destination: SurfaceSnapshot | undefined;
    for (let i = 0; i < this.surfaces.length; i++) {
      const surface = this.surfaces[i]!;
      if (surface.id === this.anchor.surfaceId) source = surface;
      if (surface.id === this.target?.surfaceId) destination = surface;
      if (i % 8 === 7) yield;
    }
    const start = endpoint(source, this.anchor, this.physics, '$start');
    const goal = this.target ? endpoint(destination, this.target, this.physics, '$goal') : null;
    if (!start || source!.sourceRevision !== this.anchor.sourceRevision || this.target && !goal) {
      this.result.status = 'unreachable';
      return;
    }
    const index = yield* SurfaceCollisionIndex.build(this.surfaces);
    const nearest: { node: Node; score: number }[] = [];
    const limit = this.target ? 62 : 47;
    const dx = goal ? goal.center.x - start.center.x : 0, dy = goal ? goal.center.y - start.center.y : 0, length = dx * dx + dy * dy;
    const score = (node: Node) => {
      if (!goal) return Math.hypot(node.center.x - start.center.x, node.center.y - start.center.y);
      const u = length ? Math.max(0, Math.min(1, ((node.center.x - start.center.x) * dx + (node.center.y - start.center.y) * dy) / length)) : 0;
      return Math.hypot(node.center.x - start.center.x - u * dx, node.center.y - start.center.y - u * dy);
    };
    for (const surface of this.surfaces) {
      for (const candidate of surfaceNodes(surface, this.physics)) {
        if (candidate.surface.id === start.surface.id && Math.abs(candidate.u - start.u) < 1e-9 || goal && candidate.surface.id === goal.surface.id && Math.abs(candidate.u - goal.u) < 1e-9) continue;
        const value = score(candidate);
        let position = nearest.findIndex(entry => entry.score > value);
        if (position < 0) position = nearest.length;
        if (position < limit) {
          nearest.splice(position, 0, { node: candidate, score: value });
          if (nearest.length > limit) nearest.pop();
        }
        yield;
      }
      yield;
    }
    const candidates = [start, ...(goal ? [goal] : []), ...nearest.map(entry => entry.node)];
    this.result.candidates = candidates.length;
    const open = new Set<Node>([start]), costs = new Map<string, number>([[start.key, 0]]), previous = new Map<string, { node: Node; edge: Edge }>(), closed = new Set<string>();
    let closest: Node | null = null;
    let closestDistance = goal ? Math.hypot(goal.center.x - start.center.x, goal.center.y - start.center.y) : Infinity;
    while (open.size) {
      let current: Node | null = null;
      for (const candidate of open) if (!current || costs.get(candidate.key)! < costs.get(current.key)!) current = candidate;
      open.delete(current!);
      closed.add(current!.key);
      this.result.expanded++;
      if (goal) {
        const distance = Math.hypot(current!.center.x - goal.center.x, current!.center.y - goal.center.y);
        if (current !== start && distance < closestDistance - 1e-6) { closest = current; closestDistance = distance; }
      }
      if (goal && current === goal) {
        this.result.status = 'found';
        this.result.route = assemble(start, goal, this.target!, previous);
        return;
      }
      for (const next of candidates) {
        if (next === current || closed.has(next.key)) continue;
        this.result.checkedEdges++;
        const sourceClimb = current!.surface.mode === 'climb', targetClimb = next.surface.mode === 'climb';
        const gap = Math.max(0, next.left - current!.right, current!.left - next.right);
        const upward = this.physics.longUpwardSpeed ?? this.physics.upwardSpeed;
        const time = crossingTime(-upward, next.center.y - current!.center.y, this.physics.gravity, this.physics.maxFallSpeed ?? Infinity);
        if (!sourceClimb && !targetClimb && !sameRange(current!, next) && (time === null || gap > (this.physics.longHorizontalSpeed ?? this.physics.maxHorizontalSpeed) * time)) { yield; continue; }
        const edge = transition(current!, next, this.surfaces, this.physics, index);
        if (edge) {
          const cost = costs.get(current!.key)! + edge.cost;
          if (cost < (costs.get(next.key) ?? Infinity)) {
            previous.set(next.key, { node: current!, edge });
            costs.set(next.key, cost);
            open.add(next);
          }
        }
        yield;
      }
    }
    if (goal) {
      this.result.status = 'unreachable';
      this.result.route = closest ? assemble(start, closest, { surfaceId: closest.surface.id, u: closest.u }, previous) : null;
    } else {
      this.result.status = 'found';
      this.reachable = candidates.filter(node => node !== start && closed.has(node.key)).map(node => ({ target: { surfaceId: node.surface.id, u: node.u }, route: assemble(start, node, { surfaceId: node.surface.id, u: node.u }, previous), cost: costs.get(node.key)! }));
    }
  }
}

export function createPlanningJob(surfaces: readonly SurfaceSnapshot[], anchor: Anchor, target: NavigationTarget, physics: NavigationPhysics): PlanningJob {
  return new PlanningJob(surfaces, { ...anchor }, { ...target }, { ...physics });
}

export function findRoute(surfaces: readonly SurfaceSnapshot[], anchor: Anchor, target: NavigationTarget, physics: NavigationPhysics): NavigationStep[] | null {
  const job = createPlanningJob(surfaces, anchor, target, physics);
  let result = job.advance(Infinity, Infinity);
  while (result.status === 'pending') result = job.advance(Infinity, Infinity);
  return result.status === 'found' ? result.route : null;
}

export function reachableRoutes(surfaces: readonly SurfaceSnapshot[], anchor: Anchor, physics: NavigationPhysics): ReachableRoute[] {
  const job = new PlanningJob(surfaces, { ...anchor }, undefined, { ...physics });
  let result = job.advance(Infinity, Infinity);
  while (result.status === 'pending') result = job.advance(Infinity, Infinity);
  return job.reachableRoutes();
}
