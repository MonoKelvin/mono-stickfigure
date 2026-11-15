import { describe, expect, it, vi } from 'vitest';
import { firstCollision, firstWall, SurfaceCollisionIndex } from '../../src/motion/solver';
import { findRoute, reachableRoutes } from '../../src/motion/navigation';
import type { NavigationPhysics } from '../../src/motion/navigation';
import type { Body, SurfaceSnapshot } from '../../src/scene/types';

const platform = (id: string, left: number, right: number, y = 100): SurfaceSnapshot => ({
  id, sourceId: id, sourceRevision: 1, geometryVersion: 1, kind: 'border',
  a: { x: left, y }, b: { x: right, y }, available: [{ start: 0, end: 1 }],
  status: 'valid', evidence: 'dom-painted-edge',
});
const solid = (id: string, left: number, right: number, top: number, bottom: number): SurfaceSnapshot => ({
  ...platform(id, left, right, top), kind: 'fill', bounds: { left, right, top, bottom },
});
const physics: NavigationPhysics = {
  gravity: 980, upwardSpeed: 320, maxHorizontalSpeed: 100,
  acceleration: 300, anticipation: 0.16, walkSpeed: 20, footRadius: 4, bodyHeight: 16,
};

function noise(count: number): SurfaceSnapshot[] {
  return Array.from({ length: count }, (_, i) => ({
    ...solid(`noise-${i}`, -10000 - i * 20, -9990 - i * 20, -1000, -990),
    available: [],
  }));
}

// Count actual exact-solver reads, not unstable wall-clock timing or browser FPS.
function countReads(surfaces: SurfaceSnapshot[]) {
  let reads = 0;
  const observed = surfaces.map((surface) => {
    const a = surface.a, bounds = surface.bounds;
    return { ...surface, get a() { reads++; return a; }, get bounds() { reads++; return bounds; } };
  });
  return { surfaces: observed, reset: () => { reads = 0; }, reads: () => reads };
}

describe('collision broad-phase performance and safety', () => {
  it('retains land, wall and ceiling hits with 1500 unrelated surfaces', () => {
    const unrelated = noise(1500);
    const body: Body = { position: { x: 0, y: 100 }, velocity: { x: 100, y: -100 } };
    for (const [obstacle, kind] of [
      [platform('land', 0, 300, 120), 'land'],
      [solid('wall', 20, 30, 50, 120), 'wall'],
      [solid('ceiling', 20, 40, 20, 60), 'ceiling'],
    ] as const) {
      const surfaces = [...unrelated, obstacle];
      const indexed = firstCollision(body, surfaces, 3, 100, 4, 16, Infinity, undefined, new SurfaceCollisionIndex(surfaces));
      expect(indexed).toEqual(firstCollision(body, surfaces, 3, 100, 4, 16));
      expect(indexed?.kind).toBe(kind);
      expect(indexed?.surfaceId).toBe(obstacle.id);
    }
    const wall = solid('walking-wall', 20, 30, 50, 120);
    wall.b.y += 5; // Walk collisions still include non-horizontal bounded surfaces.
    const surfaces = [...unrelated, wall];
    expect(firstWall(body.position, 100, surfaces, 4, 16, new SurfaceCollisionIndex(surfaces)))
      .toEqual({ surfaceId: wall.id, x: 16 });
  });

  it('matches the exact scan for seeded sweeps including apex, terminal speed, infinite flights and ignored IDs', () => {
    let seed = 0x12345678;
    const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32; };
    const surfaces = Array.from({ length: 100 }, (_, i) => {
      const left = random() * 600 - 300, top = random() * 500 - 100;
      const surface = solid(`surface-${i}`, left, left + random() * 80 + 1, top, top + random() * 120 + 1);
      if (i % 4 === 0) surface.available = [{ start: 0.25, end: 0.5 }];
      if (i % 11 === 0) surface.status = 'invalid';
      return surface;
    });
    const index = new SurfaceCollisionIndex(surfaces);
    for (let i = 0; i < 250; i++) {
      const body = { position: { x: random() * 600 - 300, y: random() * 400 }, velocity: { x: random() * 400 - 200, y: random() * 400 - 300 } };
      const duration = i % 5 === 0 ? Infinity : random() * 4;
      const terminal = i % 3 === 0 ? 90 : Infinity;
      const ignored = i % 7 === 0 ? `surface-${i % surfaces.length}` : undefined;
      expect(firstCollision(body, surfaces, duration, 100, 4, 16, terminal, ignored, index))
        .toEqual(firstCollision(body, surfaces, duration, 100, 4, 16, terminal, ignored));
      const destination = random() * 600 - 300;
      expect(firstWall(body.position, destination, surfaces, 4, 16, index)).toEqual(firstWall(body.position, destination, surfaces, 4, 16));
    }
  });

  it('preserves exact ties, tolerance-edge hits and available ranges outside endpoints', () => {
    const surfaces = [platform('original-first', -5, 5, 10 + 1e-10), platform('second', -5, 5, 10), ...noise(100)];
    const body = { position: { x: 0, y: 0 }, velocity: { x: 0, y: 10 } };
    const index = new SurfaceCollisionIndex(surfaces);
    expect(firstCollision(body, surfaces, 2, 100, 0, 0, Infinity, undefined, index))
      .toEqual(firstCollision(body, surfaces, 2, 100, 0, 0));
    expect(firstCollision(body, surfaces, 2, 100, 0, 0, Infinity, undefined, index)?.surfaceId).toBe('original-first');
    const extended = { ...platform('extended', 0, 10, 10), available: [{ start: 10, end: 11 }] };
    const outside = { position: { x: 105, y: 0 }, velocity: { x: 0, y: 10 } };
    const extendedSurfaces = [extended];
    expect(firstCollision(outside, extendedSurfaces, 2, 100, 0, 0, Infinity, undefined, new SurfaceCollisionIndex(extendedSurfaces)))
      .toEqual(firstCollision(outside, extendedSurfaces, 2, 100, 0, 0));
    const toleranceSurfaces = [platform('negative-time-tolerance', -5, 5, -0.0005)];
    const fast = { position: { x: 0, y: 0 }, velocity: { x: 0, y: 1e6 } };
    expect(firstCollision(fast, toleranceSurfaces, 0.01, 100, 0, 0, Infinity, undefined, new SurfaceCollisionIndex(toleranceSurfaces)))
      .toEqual(firstCollision(fast, toleranceSurfaces, 0.01, 100, 0, 0));
    expect(firstCollision(fast, toleranceSurfaces, 0.01, 100, 0, 0)?.surfaceId).toBe('negative-time-tolerance');
    const narrow = [solid('tolerance', 10 + 5e-7, 12, 0, 20)];
    const origin = { x: 0, y: 10 };
    expect(firstWall(origin, 10, narrow, 0, 5, new SurfaceCollisionIndex(narrow))).toEqual(firstWall(origin, 10, narrow, 0, 5));
  });

  it('reduces exact-solver reads by over 99% after one index build', () => {
    const watched = countReads([...noise(1500), solid('wall', 20, 30, 50, 120)]);
    const body = { position: { x: 0, y: 100 }, velocity: { x: 100, y: -100 } };
    const index = new SurfaceCollisionIndex(watched.surfaces);
    watched.reset();
    for (let i = 0; i < 40; i++) {
      firstCollision(body, watched.surfaces, 0.5, 100, 4, 16);
      firstWall(body.position, 100, watched.surfaces, 4, 16);
    }
    const brute = watched.reads();
    watched.reset();
    for (let i = 0; i < 40; i++) {
      firstCollision(body, watched.surfaces, 0.5, 100, 4, 16, Infinity, undefined, index);
      firstWall(body.position, 100, watched.surfaces, 4, 16, index);
    }
    const indexed = watched.reads();
    console.info(`broad-phase exact reads: ${brute} -> ${indexed} (index build excluded)`);
    expect(indexed).toBeLessThan(brute / 100);
  });

  it('retains bounded navigation results and obstacles while reducing whole-search geometry reads', () => {
    const scene = [...noise(1500), ...Array.from({ length: 12 }, (_, i) => platform(`p${i}`, i * 100, i * 100 + 80))];
    const watched = countReads(scene);
    const anchor = { surfaceId: 'p0', sourceRevision: 1, u: 0.5 };
    const bruteQuery = vi.spyOn(SurfaceCollisionIndex.prototype, 'query').mockImplementation(function (this: SurfaceCollisionIndex) { return this.surfaces; });
    const bruteRoutes = reachableRoutes(watched.surfaces, anchor, physics);
    const brute = watched.reads();
    bruteQuery.mockRestore();
    watched.reset();
    const indexedRoutes = reachableRoutes(watched.surfaces, anchor, physics);
    const indexed = watched.reads();
    expect(indexedRoutes).toEqual(bruteRoutes);
    expect(indexedRoutes.length).toBeGreaterThan(0);
    console.info(`whole reachableRoutes geometry reads: ${brute} -> ${indexed} (both include index construction)`);
    expect(indexed).toBeLessThan(brute / 10);
    const blocked = [...scene, solid('barrier', 90, 95, -100, 120)];
    expect(findRoute(blocked, anchor, { surfaceId: 'p1', u: 0.5 }, physics)).toBeNull();
    expect(reachableRoutes(blocked, anchor, physics).some(({ target }) => target.surfaceId === 'p1')).toBe(false);
  });
});
