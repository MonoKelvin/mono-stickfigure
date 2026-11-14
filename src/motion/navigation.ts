import { firstCollision, firstWall, planJump } from './solver';
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
  kind: 'walk' | 'jump' | 'drop';
  sourceRevision: number;
  takeoff?: TakeoffPlan;
}

export interface NavigationPhysics {
  gravity: number;
  upwardSpeed: number;
  maxHorizontalSpeed: number;
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
  left: number;
  right: number;
  center: Point;
}

interface Edge {
  departure: number;
  destination: number;
  kind: 'jump' | 'drop';
  cost: number;
  takeoff?: TakeoffPlan;
}

export interface ReachableRoute {
  target: NavigationTarget;
  route: NavigationStep[];
  cost: number;
}

export function firstLanding(origin: Point, velocity: Point, surfaces: readonly SurfaceSnapshot[], gravity: number, footRadius: number, ignoredId?: string, bodyHeight = 0): { surfaceId: string; u: number; time: number } | null {
  const collision = firstCollision({ position: origin, velocity }, surfaces, Number.POSITIVE_INFINITY, gravity, footRadius, bodyHeight, Number.POSITIVE_INFINITY, ignoredId);
  return collision?.kind === 'land' ? { surfaceId: collision.surfaceId, u: collision.u, time: collision.time } : null;
}

export function planTakeoff(source: SurfaceSnapshot, u: number, target: Point, physics: NavigationPhysics, long: boolean, surfaces: readonly SurfaceSnapshot[], targetId: string): TakeoffPlan | null {
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
    const velocity = planJump({ x: launchX, y: source.a.y }, target, limit, upwardSpeed, physics.gravity);
    if (!velocity) continue;
    const speed = Math.abs(velocity.x);
    const distance = speed ** 2 / (2 * acceleration) + speed * (physics.anticipation ?? 0.16);
    const startX = launchX - Math.sign(velocity.x) * distance;
    if (startX < left - 1e-6 || startX > right + 1e-6) continue;
    if (firstWall({ x: startX, y: source.a.y }, launchX, surfaces, physics.footRadius, physics.bodyHeight ?? 0)) continue;
    const landing = firstLanding({ x: launchX, y: source.a.y }, velocity, surfaces, physics.gravity, physics.footRadius, undefined, physics.bodyHeight ?? 0);
    if (!landing || landing.surfaceId !== targetId) continue;
    const destination = surfaces.find((surface) => surface.id === landing.surfaceId)!;
    const landingX = destination.a.x + (destination.b.x - destination.a.x) * landing.u;
    if (Math.abs(landingX - target.x) > physics.footRadius || Math.abs(destination.a.y - target.y) > 1) continue;
    return { startU: (startX - source.a.x) / width, launchU: (launchX - source.a.x) / width, velocity, long };
  }
  return null;
}

function transition(from: Node, to: Node, surfaces: readonly SurfaceSnapshot[], physics: NavigationPhysics): Edge | null {
  const overlapLeft = Math.max(from.left, to.left), overlapRight = Math.min(from.right, to.right);
  const overlap = overlapLeft <= overlapRight;
  const start = overlap ? (overlapLeft + overlapRight) / 2 : to.left > from.right ? from.right : from.left;
  const inset = Math.min((to.right - to.left) / 2, physics.footRadius);
  const end = overlap ? start : to.left > from.right ? to.left + inset : to.right - inset;
  if (firstWall(to.center, end, surfaces, physics.footRadius, physics.bodyHeight ?? 0)) return null;
  if (overlap && to.center.y > from.center.y + 1) {
    if (firstWall(from.center, start, surfaces, physics.footRadius, physics.bodyHeight ?? 0)) return null;
    const landing = firstLanding({ x: start, y: from.center.y }, { x: 0, y: 0 }, surfaces, physics.gravity, physics.footRadius, from.surface.id, physics.bodyHeight ?? 0);
    if (landing?.surfaceId === to.surface.id) return {
      departure: (start - from.surface.a.x) / (from.surface.b.x - from.surface.a.x), destination: landing.u, kind: 'drop',
      cost: Math.abs(from.center.x - start) / physics.walkSpeed + landing.time + Math.abs(end - to.center.x) / physics.walkSpeed,
    };
  }
  const sourceU = (start - from.surface.a.x) / (from.surface.b.x - from.surface.a.x);
  for (const long of [false, true]) {
    if (long && (!physics.longUpwardSpeed || !physics.longHorizontalSpeed)) continue;
    const takeoff = planTakeoff(from.surface, sourceU, { x: end, y: to.center.y }, physics, long, surfaces, to.surface.id);
    if (!takeoff) continue;
    const launchX = from.surface.a.x + (from.surface.b.x - from.surface.a.x) * takeoff.launchU;
    const startX = from.surface.a.x + (from.surface.b.x - from.surface.a.x) * takeoff.startU;
    if (startX < from.left - 1e-6 || startX > from.right + 1e-6 || firstWall(from.center, startX, surfaces, physics.footRadius, physics.bodyHeight ?? 0)) continue;
    const landing = firstLanding({ x: launchX, y: from.center.y }, takeoff.velocity, surfaces, physics.gravity, physics.footRadius, undefined, physics.bodyHeight ?? 0);
    if (!landing || landing.surfaceId !== to.surface.id) continue;
    const x = to.surface.a.x + (to.surface.b.x - to.surface.a.x) * landing.u;
    if (x < to.left - 1e-6 || x > to.right + 1e-6) continue;
    return {
      departure: takeoff.startU, destination: landing.u, kind: 'jump', takeoff,
      cost: Math.abs(from.center.x - startX) / physics.walkSpeed + Math.abs(takeoff.velocity.x) / (physics.acceleration ?? physics.maxHorizontalSpeed * 4) + (physics.anticipation ?? 0.16) + landing.time + Math.abs(x - to.center.x) / physics.walkSpeed,
    };
  }
  return null;
}

function platformNodes(surfaces: readonly SurfaceSnapshot[], footRadius: number): Node[] {
  const nodes: Node[] = [];
  for (const surface of surfaces) {
    if (surface.status !== 'valid' || Math.abs(surface.a.y - surface.b.y) > 1e-6) continue;
    for (let i = 0; i < surface.available.length; i++) {
      const interval = surface.available[i]!;
      const width = surface.b.x - surface.a.x;
      const left = surface.a.x + interval.start * width + footRadius;
      const right = surface.a.x + interval.end * width - footRadius;
      if (right >= left) nodes.push({ key: `${surface.id}:${i}`, surface, left, right, center: { x: (left + right) / 2, y: surface.a.y } });
    }
  }
  return nodes;
}

function contains(node: Node, target: NavigationTarget): boolean {
  const x = node.surface.a.x + (node.surface.b.x - node.surface.a.x) * target.u;
  return node.surface.id === target.surfaceId && x >= node.left - 1e-6 && x <= node.right + 1e-6;
}

function search(candidates: readonly Node[], start: Node, surfaces: readonly SurfaceSnapshot[], physics: NavigationPhysics, goal?: Node) {
  const open = new Set<Node>([start]);
  const costs = new Map<string, number>([[start.key, 0]]);
  const previous = new Map<string, { node: Node; edge: Edge }>();
  const closed = new Set<string>();
  const estimate = (node: Node) => costs.get(node.key)!;
  while (open.size) {
    let current: Node | null = null;
    for (const node of open) if (!current || estimate(node) < estimate(current)) current = node;
    if (current === goal) break;
    open.delete(current!);
    closed.add(current!.key);
    for (const next of candidates) {
      if (next === current || closed.has(next.key)) continue;
      const gap = Math.max(0, next.left - current!.right, current!.left - next.right);
      const upward = physics.longUpwardSpeed ?? physics.upwardSpeed;
      const discriminant = upward ** 2 + 2 * physics.gravity * (next.center.y - current!.center.y);
      if (discriminant <= 0 || gap > (physics.longHorizontalSpeed ?? physics.maxHorizontalSpeed) * (upward + Math.sqrt(discriminant)) / physics.gravity) continue;
      const edge = transition(current!, next, surfaces, physics);
      if (!edge) continue;
      const cost = costs.get(current!.key)! + edge.cost;
      if (cost >= (costs.get(next.key) ?? Infinity)) continue;
      previous.set(next.key, { node: current!, edge });
      costs.set(next.key, cost);
      open.add(next);
    }
  }
  return { costs, previous };
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
    steps.push({ kind: 'walk', surfaceId: from.surface.id, u: edge.departure, sourceRevision: from.surface.sourceRevision });
    steps.push({ kind: edge.kind, surfaceId: to.surface.id, u: edge.destination, sourceRevision: to.surface.sourceRevision, ...(edge.takeoff ? { takeoff: edge.takeoff } : {}) });
  }
  return [...steps, { kind: 'walk', ...target, sourceRevision: goal.surface.sourceRevision }];
}

export function findRoute(surfaces: readonly SurfaceSnapshot[], anchor: Anchor, target: NavigationTarget, physics: NavigationPhysics): NavigationStep[] | null {
  const nodes = platformNodes(surfaces, physics.footRadius);
  const start = nodes.find((node) => contains(node, anchor));
  const goal = nodes.find((node) => contains(node, target));
  if (!start || !goal) return null;
  if (start === goal) {
    const origin = { x: start.surface.a.x + (start.surface.b.x - start.surface.a.x) * anchor.u, y: start.center.y };
    const destination = goal.surface.a.x + (goal.surface.b.x - goal.surface.a.x) * target.u;
    return firstWall(origin, destination, surfaces, physics.footRadius, physics.bodyHeight ?? 0) ? null : assemble(start, goal, target, new Map());
  }
  const dx = goal.center.x - start.center.x, dy = goal.center.y - start.center.y;
  const length = dx ** 2 + dy ** 2;
  const score = (node: Node) => {
    const u = length ? Math.max(0, Math.min(1, ((node.center.x - start.center.x) * dx + (node.center.y - start.center.y) * dy) / length)) : 0;
    return Math.hypot(node.center.x - start.center.x - u * dx, node.center.y - start.center.y - u * dy);
  };
  const candidates = [start, goal, ...nodes.filter((node) => node !== start && node !== goal).sort((a, b) => score(a) - score(b)).slice(0, 62)];
  const { costs, previous } = search(candidates, start, surfaces, physics, goal);
  return costs.has(goal.key) ? assemble(start, goal, target, previous) : null;
}

export function reachableRoutes(surfaces: readonly SurfaceSnapshot[], anchor: Anchor, physics: NavigationPhysics): ReachableRoute[] {
  const nodes = platformNodes(surfaces, physics.footRadius);
  const start = nodes.find((node) => contains(node, anchor));
  if (!start) return [];
  const others = nodes.filter((node) => node !== start).sort((a, b) => Math.hypot(a.center.x - start.center.x, a.center.y - start.center.y) - Math.hypot(b.center.x - start.center.x, b.center.y - start.center.y));
  const near = others.slice(0, 31), distant = others.slice(31);
  const spread = distant.length <= 16 ? distant : Array.from({ length: 16 }, (_, i) => distant[Math.floor(i * (distant.length - 1) / 15)]!);
  const candidates = [start, ...near, ...spread];
  const { costs, previous } = search(candidates, start, surfaces, physics);
  return candidates.filter((node) => node !== start && costs.has(node.key)).map((node) => {
    const target = { surfaceId: node.surface.id, u: (node.center.x - node.surface.a.x) / (node.surface.b.x - node.surface.a.x) };
    return { target, route: assemble(start, node, target, previous), cost: costs.get(node.key)! };
  });
}
