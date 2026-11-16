import { describe, expect, it } from 'vitest';
import { createPlanningJob, findRoute, firstLanding, reachableRoutes } from '../../src/motion/navigation';
import type { NavigationPhysics } from '../../src/motion/navigation';
import { planJump, stepBody } from '../../src/motion/solver';
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

function complete(job: ReturnType<typeof createPlanningJob>, work = 1) {
  let result = job.advance(Infinity, work), turns = 1;
  while (result.status === 'pending') {
    const edges = result.checkedEdges;
    result = job.advance(Infinity, work);
    expect(result.checkedEdges - edges).toBeLessThanOrEqual(work);
    expect(++turns).toBeLessThan(20000);
  }
  return { result, turns };
}

describe('预算化 Dijkstra 与有限坠落速度', () => {
  it('零预算不做工作，单操作切片与一次完整搜索返回相同路线', () => {
    const scene = Array.from({ length: 8 }, (_, i) => platform(`p${i}`, i * 100, i * 100 + 80));
    const anchor = { surfaceId: 'p0', sourceRevision: 1, u: 0.25 }, goal = { surfaceId: 'p7', u: 0.75 };
    const job = createPlanningJob(scene, anchor, goal, physics);
    expect(job.advance(0)).toEqual({ status: 'pending', route: null, candidates: 0, expanded: 0, checkedEdges: 0, elapsedMs: 0 });
    const { result, turns } = complete(job);
    expect(turns).toBeGreaterThan(20);
    expect(result.status).toBe('found');
    expect(result.route).toEqual(findRoute(scene, anchor, goal, physics));
    expect(result.candidates).toBeLessThanOrEqual(64);
    expect(result.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(result.route!.at(-1)).toMatchObject(goal);
  });

  it('预算耗尽不报告不可达，缺失来源或旧代次才确定失败', () => {
    const scene = [platform('source', 0, 80), platform('far', 10000, 10100)];
    const anchor = { surfaceId: 'source', sourceRevision: 1, u: 0.5 }, goal = { surfaceId: 'far', u: 0.5 };
    const job = createPlanningJob(scene, anchor, goal, physics);
    expect(job.advance(Infinity, 1).status).toBe('pending');
    expect(complete(job).result.status).toBe('unreachable');
    expect(complete(createPlanningJob(scene, { ...anchor, sourceRevision: 2 }, goal, physics)).result.status).toBe('unreachable');
  });

  it('不可达时只提供已经定型且更接近最终目标的中间路线', () => {
    const scene = [platform('source', 0, 80), platform('near', 100, 180), platform('far', 10000, 10100)];
    const anchor = { surfaceId: 'source', sourceRevision: 1, u: 0.5 }, goal = { surfaceId: 'far', u: 0.5 };
    const result = complete(createPlanningJob(scene, anchor, goal, physics)).result;
    expect(result.status).toBe('unreachable');
    expect(result.route!.at(-1)!.surfaceId).toBe('near');
    expect(findRoute(scene, anchor, goal, physics)).toBeNull();
  });

  it('有限下落速度的首次落点与实际积分一致', () => {
    const scene = [platform('floor', -1000, 1000, 1000)];
    const limited = { ...physics, maxFallSpeed: 120 };
    const origin = { x: 0, y: 0 }, target = { x: 600, y: 1000 };
    const velocity = planJump(origin, target, 100, 320, limited.gravity, limited.maxFallSpeed)!;
    const landing = firstLanding(origin, velocity, scene, limited.gravity, 4, undefined, 16, undefined, limited.maxFallSpeed)!;
    expect(landing.surfaceId).toBe('floor');
    const actual = stepBody({ position: origin, velocity }, scene, landing.time + 0.01, limited.gravity, limited.maxFallSpeed, 4, 16);
    expect(actual.landing?.surfaceId).toBe(landing.surfaceId);
    expect(actual.body.position.x).toBeCloseTo(target.x, 7);
    expect(actual.body.position.y).toBeCloseTo(target.y, 7);
  });
});
