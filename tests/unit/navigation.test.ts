import { describe, expect, it } from 'vitest';
import { findRoute, reachableRoutes } from '../../src/motion/navigation';
import type { NavigationPhysics } from '../../src/motion/navigation';
import type { SurfaceSnapshot } from '../../src/scene/types';

const platform = (id: string, left: number, right: number, y = 100): SurfaceSnapshot => ({
  id, sourceId: id, sourceRevision: 1, geometryVersion: 1, kind: 'border',
  a: { x: left, y }, b: { x: right, y }, available: [{ start: 0, end: 1 }],
  status: 'valid', evidence: 'dom-painted-edge',
});
const physics: NavigationPhysics = {
  gravity: 980, upwardSpeed: 320, maxHorizontalSpeed: 100,
  acceleration: 300, anticipation: 0.16, walkSpeed: 20, footRadius: 4, bodyHeight: 16,
};
const wall: SurfaceSnapshot = {
  ...platform('wall', 80, 90, -100), kind: 'fill',
  bounds: { left: 80, right: 90, top: -100, bottom: 110 },
};

describe('导航使用实际站立位置', () => {
  it('不会从障碍另一侧的平台中心出发规划路线', () => {
    const surfaces = [platform('source', 0, 200), platform('target', 220, 300), wall];
    const anchor = { surfaceId: 'source', sourceRevision: 1, u: 0.25 };
    expect(findRoute(surfaces, anchor, { surfaceId: 'target', u: 0.5 }, physics)).toBeNull();
    expect(reachableRoutes(surfaces, anchor, physics).some(({ target }) => target.surfaceId === 'target')).toBe(false);
    const unblocked = { ...anchor, u: 0.75 };
    expect(findRoute(surfaces, unblocked, { surfaceId: 'target', u: 0.5 }, physics)).not.toBeNull();
    expect(reachableRoutes(surfaces, unblocked, physics).some(({ target }) => target.surfaceId === 'target')).toBe(true);
  });

  it('不会把终点平台中心可达误认为实际终点可达', () => {
    const surfaces = [platform('source', 220, 300), platform('target', 0, 200), wall];
    const anchor = { surfaceId: 'source', sourceRevision: 1, u: 0.5 };
    expect(findRoute(surfaces, anchor, { surfaceId: 'target', u: 0.25 }, physics)).toBeNull();
    expect(findRoute(surfaces, anchor, { surfaceId: 'target', u: 0.75 }, physics)).not.toBeNull();
  });
});
