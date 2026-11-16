import { describe, expect, it } from 'vitest';
import { captureClimbAttachment } from '../../src/animation/climb';
import type { ClimbAttachmentState } from '../../src/animation/climb';
import { createPlanningJob } from '../../src/motion/navigation';
import type { NavigationStep, PlanningJob } from '../../src/motion/navigation';
import { StickFigureController } from '../../src/runtime/controller';
import type { Anchor, Body, ClimbContact, SurfaceSnapshot, Viewport } from '../../src/scene/types';

interface Internals {
  body: Body;
  support: Anchor;
  goal: { surfaceId: string; sourceRevision: number; u: number; automatic: boolean };
  planning: PlanningJob | null;
  planningAnchor: Anchor;
  route: NavigationStep[];
  store: { get(id: string): SurfaceSnapshot | null; snapshots(): SurfaceSnapshot[]; clear(): void; pinned?: Set<string>; refresh?(id: string, viewport: Viewport): SurfaceSnapshot | null };
  advanceNavigation(): void;
  nearestClimb(): { surface: SurfaceSnapshot; u: number } | null;
  chooseRandomGoal(viewport: Viewport): boolean;
  random(): number;
  climb: ClimbContact;
  climbAttachment: ClimbAttachmentState | null;
  stepClimbing(dt: number): void;
  descentDistance: number;
  handleBoundary(viewport: Viewport): void;
  collisionSurfaces(surfaces: SurfaceSnapshot[], viewport: Viewport): SurfaceSnapshot[];
}

const platform: SurfaceSnapshot = {
  id: 'floor', sourceId: 'floor', sourceRevision: 1, geometryVersion: 1,
  kind: 'border', a: { x: 0, y: 100 }, b: { x: 100, y: 100 },
  available: [{ start: 0, end: 1 }], status: 'valid', evidence: 'dom-painted-edge',
};

function fixture(current: SurfaceSnapshot, original = platform) {
  const actor = new StickFigureController({ autonomous: false, performance: { navigationBudgetMs: 5 } });
  const internals = actor as unknown as Internals;
  const anchor = { surfaceId: platform.id, sourceRevision: 1, u: 0.5 };
  const goal = { surfaceId: platform.id, sourceRevision: 1, u: 0.9, automatic: false };
  internals.body = { position: { x: (current.a.x + current.b.x) / 2, y: current.a.y }, velocity: { x: 0, y: 0 } };
  internals.support = anchor;
  internals.goal = goal;
  internals.planningAnchor = { ...anchor };
  internals.store = { get: id => id === current.id ? current : null, snapshots: () => [current], clear: () => {} };
  internals.planning = createPlanningJob([original], anchor, goal, { gravity: 980, upwardSpeed: 320, maxHorizontalSpeed: 100, walkSpeed: 20, footRadius: 4, bodyHeight: 16 });
  for (let i = 0; i < 100 && internals.planning; i++) internals.advanceNavigation();
  return { actor, internals };
}

describe('规划结果与当前几何的整合', () => {
  it('宽度已改变时拒绝旧结果，但保留最终目的地等待重规划', () => {
    const { actor, internals } = fixture({ ...platform, geometryVersion: 2, b: { x: 140, y: 100 } });
    expect(internals.route).toEqual([]);
    expect(actor.getSnapshot().navigation.reason).toBe('scene-changed');
    expect(actor.getSnapshot().target?.surfaceId).toBe(platform.id);
    actor.destroy();
  });

  it('实体高度改变但顶部未动时也不能沿用旧规划', () => {
    const original: SurfaceSnapshot = { ...platform, kind: 'fill', bounds: { left: 0, right: 100, top: 100, bottom: 140 } };
    const { actor, internals } = fixture({ ...original, geometryVersion: 2, bounds: { ...original.bounds!, bottom: 200 } }, original);
    expect(internals.route).toEqual([]);
    expect(actor.getSnapshot().navigation.reason).toBe('scene-changed');
    actor.destroy();
  });

  it('长墙顶部很远时，仍按附近边段而不是最终目的地判断可攀爬', () => {
    const wall: SurfaceSnapshot = { ...platform, mode: 'climb', normal: { x: -1, y: 0 }, a: { x: 20, y: 0 }, b: { x: 20, y: 1000 } };
    const actor = new StickFigureController({ autonomous: false });
    const internals = actor as unknown as Internals;
    internals.body = { position: { x: 15.84, y: 995 }, velocity: { x: 0, y: 0 } };
    internals.store = { get: () => wall, snapshots: () => [wall], clear: () => {} };
    expect(internals.nearestClimb()).toEqual({ surface: wall, u: 0.18 });
    actor.destroy();
  });

  it('随机点过近时使用有界候选，不短暂清空可用的新目标', () => {
    const actor = new StickFigureController({ autonomous: false });
    const internals = actor as unknown as Internals;
    internals.body = { position: { x: 50, y: 100 }, velocity: { x: 0, y: 0 } };
    internals.support = { surfaceId: platform.id, sourceRevision: 1, u: 0.5 };
    internals.store = { get: () => platform, snapshots: () => [platform], clear: () => {} };
    internals.random = () => 0.5;
    expect(internals.chooseRandomGoal({ left: 0, top: 0, right: 200, bottom: 200 })).toBe(true);
    const target = actor.getSnapshot().target!;
    expect(Math.abs(target.position.x - 50)).toBeGreaterThanOrEqual(16);
    expect(actor.getSnapshot().navigation.status).toBe('planning');
    actor.destroy();
  });

  it('抓墙后先停稳，沿墙速度有界且明显慢于走跑', () => {
    const wall: SurfaceSnapshot = { ...platform, mode: 'climb', normal: { x: -1, y: 0 }, a: { x: 20, y: 0 }, b: { x: 20, y: 1000 } };
    const actor = new StickFigureController({ autonomous: false });
    const internals = actor as unknown as Internals;
    internals.body = { position: { x: 15.84, y: 600 }, velocity: { x: 0, y: 0 } };
    internals.climb = { surfaceId: wall.id, sourceRevision: 1, u: 0.6, normal: { x: -1, y: 0 } };
    internals.climbAttachment = captureClimbAttachment(1, { x: 0, y: 0 }, wall.normal!, 16, 980);
    internals.goal = { surfaceId: wall.id, sourceRevision: 1, u: 0.18, automatic: false };
    internals.route = [{ kind: 'climb', surfaceId: wall.id, sourceRevision: 1, u: 0.18 }];
    internals.store = { get: () => wall, snapshots: () => [wall], clear: () => {} };
    for (let frame = 0; frame < 72; frame++) {
      internals.stepClimbing(1 / 120);
      expect(internals.body.position.y).toBeCloseTo(600, 8);
      expect(internals.body.velocity.y).toBe(0);
    }
    for (let frame = 0; frame < 120; frame++) {
      internals.stepClimbing(1 / 120);
      expect(Math.hypot(internals.body.velocity.x, internals.body.velocity.y)).toBeLessThanOrEqual(6.4 + 1e-8);
    }
    expect(internals.body.position.y).toBeLessThan(600);
    actor.destroy();
  });

  it('目标被替换后，不能把旧自动路线交给新的手动目标', () => {
    const actor = new StickFigureController({ autonomous: false });
    const internals = actor as unknown as Internals;
    const anchor = { surfaceId: platform.id, sourceRevision: 1, u: 0.5 };
    internals.body = { position: { x: 50, y: 100 }, velocity: { x: 0, y: 0 } };
    internals.support = anchor;
    internals.goal = { surfaceId: platform.id, sourceRevision: 1, u: 0.8, automatic: false };
    internals.planningAnchor = anchor;
    internals.store = { get: () => platform, snapshots: () => [platform], clear: () => {} };
    internals.planning = createPlanningJob([platform], anchor, { surfaceId: platform.id, u: 0.9 }, { gravity: 980, upwardSpeed: 320, maxHorizontalSpeed: 100, walkSpeed: 20, footRadius: 4, bodyHeight: 16 });
    internals.advanceNavigation();
    expect(internals.planning).toBeNull();
    expect(internals.route).toEqual([]);
    expect(actor.getSnapshot().target!.u).toBe(0.8);
    actor.destroy();
  });

  it('从下方循环重入时清除上一段落差，不能错误触发高落地翻滚', () => {
    const actor = new StickFigureController({ autonomous: false });
    const internals = actor as unknown as Internals;
    internals.body = { position: { x: 100, y: 1000 }, velocity: { x: 0, y: 600 } };
    internals.descentDistance = 1000;
    internals.handleBoundary({ left: 0, top: 0, right: 200, bottom: 200 });
    expect(internals.descentDistance).toBe(0);
    expect(internals.body.velocity.y).toBe(0);
    expect(internals.body.position.y).toBeLessThan(0);
    actor.destroy();
  });

  it('扫掠可能碰到旧坐标时先重测，预测不推进世界根', () => {
    const actor = new StickFigureController({ autonomous: false });
    const internals = actor as unknown as Internals;
    const shifted = { ...platform, a: { x: 0, y: 1000 }, b: { x: 100, y: 1000 } };
    internals.body = { position: { x: 50, y: 90 }, velocity: { x: 0, y: 400 } };
    let measured = 0;
    internals.store = { get: () => shifted, snapshots: () => [shifted], clear: () => {}, pinned: new Set(), refresh: () => { measured++; return shifted; } };
    const surfaces = internals.collisionSurfaces([platform], { left: 0, top: 0, right: 200, bottom: 200 });
    expect(measured).toBe(1);
    expect(surfaces[0]!.a.y).toBe(1000);
    expect(internals.body).toEqual({ position: { x: 50, y: 90 }, velocity: { x: 0, y: 400 } });
    expect(platform.a.y).toBe(100);
    actor.destroy();
  });

  it('抓附中取消目标后局部摆动继续收敛，世界根仍留在墙上', () => {
    const wall: SurfaceSnapshot = { ...platform, mode: 'climb', normal: { x: -1, y: 0 }, a: { x: 20, y: 0 }, b: { x: 20, y: 1000 } };
    const actor = new StickFigureController({ autonomous: false });
    const internals = actor as unknown as Internals;
    internals.body = { position: { x: 15.84, y: 600 }, velocity: { x: 0, y: 0 } };
    internals.climb = { surfaceId: wall.id, sourceRevision: 1, u: 0.6, normal: { x: -1, y: 0 } };
    internals.climbAttachment = captureClimbAttachment(1, { x: 60, y: 100 }, wall.normal!, 16, 980);
    const initial = internals.climbAttachment.angle;
    internals.route = [];
    internals.store = { get: () => wall, snapshots: () => [wall], clear: () => {} };
    for (let frame = 0; frame < 120; frame++) internals.stepClimbing(1 / 120);
    expect(internals.climbAttachment!.ready).toBe(true);
    expect(internals.climbAttachment!.angle).not.toBe(initial);
    expect(internals.body.position).toEqual({ x: 15.84, y: 600 });
    expect(internals.body.velocity).toEqual({ x: 0, y: 0 });
    actor.destroy();
  });

  it('攀爬面未知时停止推进，不进入只接受有效区间的求解器', () => {
    const wall: SurfaceSnapshot = { ...platform, mode: 'climb', status: 'unknown', normal: { x: -1, y: 0 }, a: { x: 20, y: 0 }, b: { x: 20, y: 1000 }, available: [] };
    const actor = new StickFigureController({ autonomous: false });
    const internals = actor as unknown as Internals;
    internals.body = { position: { x: 15.84, y: 600 }, velocity: { x: 0, y: -6.4 } };
    internals.climb = { surfaceId: wall.id, sourceRevision: 1, u: 0.6, normal: { x: -1, y: 0 } };
    internals.climbAttachment = captureClimbAttachment(1, { x: 0, y: 0 }, wall.normal!, 16, 980);
    internals.store = { get: () => wall, snapshots: () => [wall], clear: () => {} };
    expect(() => internals.stepClimbing(1 / 120)).not.toThrow();
    expect(internals.body.position).toEqual({ x: 15.84, y: 600 });
    expect(internals.body.velocity).toEqual({ x: 0, y: 0 });
    actor.destroy();
  });

  it('共同滚动或平移后的路线按当前参考系执行，不无限重启', () => {
    const { actor } = fixture({ ...platform, geometryVersion: 2, a: { x: 40, y: 130 }, b: { x: 140, y: 130 } });
    const snapshot = actor.getSnapshot();
    expect(snapshot.action).toBe('walk');
    expect(snapshot.navigation.reason).toBe('route-ready');
    expect(snapshot.path.at(-1)).toEqual({ x: 130, y: 130 });
    actor.destroy();
  });
});
