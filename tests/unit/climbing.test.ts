import { describe, expect, it } from 'vitest';
import { climbInterval, climbRoot, firstCollision, stepBody, stepClimb, stepFlight } from '../../src/motion/solver';
import { createPlanningJob, findRoute, firstLanding } from '../../src/motion/navigation';
import type { NavigationPhysics } from '../../src/motion/navigation';
import type { SurfaceSnapshot } from '../../src/scene/types';

const wall = (id = 'wall'): SurfaceSnapshot => ({
  id, sourceId: id, sourceRevision: 1, geometryVersion: 1, kind: 'border', mode: 'climb',
  normal: { x: -1, y: 0 }, a: { x: 20, y: 0 }, b: { x: 20, y: 200 },
  available: [{ start: 0, end: 1 }], status: 'valid', evidence: 'dom-painted-edge',
});
const platform = (id: string, left: number, right: number, y: number): SurfaceSnapshot => ({
  id, sourceId: id, sourceRevision: 1, geometryVersion: 1, kind: 'border',
  a: { x: left, y }, b: { x: right, y }, available: [{ start: 0, end: 1 }],
  status: 'valid', evidence: 'dom-painted-edge',
});
const height = 16;

function finish(job: ReturnType<typeof createPlanningJob>) {
  let result = job.advance(Infinity, 1), count = 0;
  while (result.status === 'pending') {
    result = job.advance(Infinity, 1);
    expect(++count).toBeLessThan(10000);
  }
  return result;
}

describe('攀爬扫掠与锚点运动', () => {
  it('预测返回先侧撞再落地的来源列表，但不改写传入物理状态', () => {
    const obstacle: SurfaceSnapshot = { ...platform('solid', 20, 30, -20), kind: 'fill', bounds: { left: 20, right: 30, top: -20, bottom: 100 } };
    const body = { position: { x: 0, y: 0 }, velocity: { x: 50, y: 0 } };
    const result = stepFlight(body, [obstacle, platform('floor', -100, 100, 50)], 2, 100, 600, 4, height);
    expect(result.contacts.map(contact => [contact.surfaceId, contact.kind])).toEqual([['solid', 'wall'], ['floor', 'land']]);
    expect(body).toEqual({ position: { x: 0, y: 0 }, velocity: { x: 50, y: 0 } });
  });

  it('上升过程在最早真实交点抓附，保留未消费子步时间且不瞬移', () => {
    const surface = wall();
    const body = { position: { x: 0, y: 50 }, velocity: { x: 40, y: -100 } };
    const time = (20 - height * 0.26) / 40;
    const result = stepFlight(body, [surface], 1, 100, 600, height * 0.26, height, surface.id);
    expect(result.climb).toMatchObject({ surfaceId: 'wall', sourceRevision: 1, normal: { x: -1, y: 0 } });
    expect(result.remainingTime).toBeCloseTo(1 - time, 8);
    expect(result.body.position.x).toBeCloseTo(40 * time, 8);
    expect(result.body.position.y).toBeCloseTo(50 - 100 * time + 50 * time ** 2, 8);
    const root = climbRoot(surface, result.climb!.u, height);
    expect(root.x).toBeCloseTo(result.body.position.x, 8);
    expect(root.y).toBeCloseTo(result.body.position.y, 8);
    expect(result.body.velocity).toEqual({ x: 0, y: 0 });
    expect(result.grabVelocity!.x).toBe(40);
    expect(result.grabVelocity!.y).toBeCloseTo(-100 + 100 * time, 8);
    const partial = stepBody(body, [], 0.2, 100, 600, height * 0.26, height).body;
    const split = stepFlight(partial, [surface], 0.8, 100, 600, height * 0.26, height, surface.id);
    expect(split.climb!.u).toBeCloseTo(result.climb!.u, 8);
    expect(split.remainingTime).toBeCloseTo(result.remainingTime, 8);
    expect(split.grabVelocity!.x).toBe(result.grabVelocity!.x);
    expect(split.grabVelocity!.y).toBeCloseTo(result.grabVelocity!.y, 8);
    expect(Object.keys(stepBody(body, [], 0.2, 100))).toEqual(['body', 'landing']);
  });

  it('抓附仅对明确目标启用，离开边段或已穿入边段不补吸附', () => {
    const surface = wall();
    const body = { position: { x: 0, y: 50 }, velocity: { x: 40, y: -100 } };
    expect(stepFlight(body, [surface], 1, 100, 600, 4.16, height).climb).toBeNull();
    expect(stepFlight({ position: { x: 15.84, y: 50 }, velocity: { x: -40, y: 0 } }, [surface], 1, 100, 600, 4.16, height, surface.id).climb).toBeNull();
    expect(stepFlight({ position: { x: 19, y: 50 }, velocity: { x: 40, y: 0 } }, [surface], 1, 100, 600, 4.16, height, surface.id).climb).toBeNull();
  });

  it('手脚必须有完整可用区间，80°和短边不允许攀爬', () => {
    const surface = wall();
    expect(climbInterval(surface, 0.5, height)).toEqual({ start: 0.06, end: 0.9904 });
    expect(climbInterval(surface, 0.03, height)).toBeNull();
    expect(climbInterval({ ...surface, available: [{ start: 0.4, end: 0.5 }] }, 0.45, height)).toBeNull();
    expect(climbInterval({ ...surface, b: { x: 20, y: 31 } }, 0.5, height)).toBeNull();
    const angle = 80 * Math.PI / 180;
    const slope = { ...surface, a: { x: 0, y: 0 }, b: { x: Math.cos(angle) * 200, y: Math.sin(angle) * 200 }, normal: { x: -Math.sin(angle), y: Math.cos(angle) } };
    expect(climbInterval(slope, 0.5, height)).toBeNull();
    expect(stepFlight({ position: { x: 0, y: 1 }, velocity: { x: 40, y: 0 } }, [surface], 1, 100, 600, 4.16, height, surface.id).climb).toBeNull();
  });

  it('更早实体阻挡优先，同一来源的抓附与侧撞同时发生可建立接触', () => {
    const climb = wall();
    const solid = { ...platform('solid', 20, 30, 0), sourceId: climb.sourceId, kind: 'fill' as const, bounds: { left: 20, right: 30, top: 0, bottom: 200 } };
    const body = { position: { x: 0, y: 50 }, velocity: { x: 40, y: -100 } };
    expect(firstCollision(body, [solid, climb], 1, 100, 4.16, height, 600, undefined, undefined, climb.id)?.kind).toBe('grab');
    const obstacle = { ...platform('obstacle', 12, 14, 0), kind: 'fill' as const, bounds: { left: 12, right: 14, top: 0, bottom: 200 } };
    const result = stepFlight(body, [solid, climb, obstacle], 1, 100, 600, 4.16, height, climb.id);
    expect(result.climb).toBeNull();
    expect(result.grabVelocity).toBeNull();
    expect(result.body.position.x).toBeCloseTo(12 - 4.16, 5);
  });

  it('陡斜边在终端速度后的交点仍按同一线段参数抓附', () => {
    const angle = 85 * Math.PI / 180;
    const tangent = { x: Math.cos(angle), y: Math.sin(angle) }, normal = { x: -tangent.y, y: tangent.x };
    const surface = { ...wall(), a: { x: 30, y: 0 }, b: { x: 30 + tangent.x * 600, y: tangent.y * 600 }, normal };
    const target = climbRoot(surface, 0.55, height);
    const time = 2, terminal = 120, gravity = 100;
    const position = { x: target.x - 20 * time, y: target.y - (terminal ** 2 / (2 * gravity) + terminal * (time - terminal / gravity)) };
    const body = { position, velocity: { x: 20, y: 0 } };
    const result = stepFlight(body, [surface], 3, gravity, terminal, 4.16, height, surface.id);
    expect(result.climb?.u).toBeCloseTo(0.55, 7);
    expect(result.remainingTime).toBeCloseTo(1, 7);
    expect(result.body.position.x).toBeCloseTo(target.x, 7);
    expect(result.body.position.y).toBeCloseTo(target.y, 7);
    expect(result.grabVelocity).toEqual({ x: 20, y: terminal });
  });

  it('攀爬通过沿面加速推进锚点，子步拆分一致且到边界停止', () => {
    const surface = wall();
    const body = { position: climbRoot(surface, 0.5, height), velocity: { x: 0, y: 0 } };
    const whole = stepClimb(body, surface, 0.5, -20, 80, 1, height);
    expect(whole.distance).toBeCloseTo(17.5, 8);
    let state = body, u = 0.5;
    for (let i = 0; i < 120; i++) {
      const result = stepClimb(state, surface, u, -20, 80, 1 / 120, height);
      state = result.body;
      u = result.u;
    }
    expect(u).toBeCloseTo(whole.u, 8);
    expect(state.position.y).toBeCloseTo(whole.body.position.y, 8);
    const edge = stepClimb(body, surface, 0.5, -20, 80, 20, height);
    expect(edge.edge).toBe(-1);
    expect(edge.u).toBeCloseTo(climbInterval(surface, 0.5, height)!.start, 8);
    expect(edge.body.velocity).toEqual({ x: 0, y: 0 });
  });
});

describe('平台与攀爬段路线闭环', () => {
  const physics: NavigationPhysics = { gravity: 980, upwardSpeed: 320, maxHorizontalSpeed: 100, maxFallSpeed: 600, acceleration: 300, anticipation: 0.16, walkSpeed: 20, climbSpeed: 20, footRadius: 4.16, bodyHeight: height };

  it('平台先实际助跑跃起，再在上升或下降途中抓住边段', () => {
    const climb = { ...wall(), a: { x: 100, y: 0 }, b: { x: 100, y: 160 } };
    const scene = [platform('source', 0, 80, 100), climb];
    const anchor = { surfaceId: 'source', sourceRevision: 1, u: 0.5 }, target = { surfaceId: climb.id, u: 0.5 };
    const route = findRoute(scene, anchor, target, physics)!;
    expect(route).not.toBeNull();
    const grab = route.find(step => step.kind === 'grab')!;
    expect(grab).toBeDefined();
    const plan = grab.takeoff!;
    const origin = { x: 80 * plan.launchU, y: 100 };
    const result = stepFlight({ position: origin, velocity: plan.velocity }, scene, 2, physics.gravity, 600, physics.footRadius, height, climb.id);
    expect(result.climb?.surfaceId).toBe(climb.id);
    expect(result.climb?.u).toBeCloseTo(grab.u, 7);
    expect(route.at(-1)).toMatchObject({ kind: 'climb', ...target });
    expect(finish(createPlanningJob(scene, anchor, target, physics)).route).toEqual(route);
  });

  it('明确攀爬目标不能抓墙后绕平台抄近路，普通移动仍可组合路线', () => {
    const climb = { ...wall(), a: { x: 100, y: 0 }, b: { x: 100, y: 200 } };
    const scene = [platform('side', 0, 90, 100), climb];
    const anchor = { surfaceId: climb.id, sourceRevision: 1, u: 0.85 }, target = { surfaceId: climb.id, u: 0.1 };
    const travel: NavigationPhysics = { ...physics, climbSpeed: 1, longUpwardSpeed: 410, longHorizontalSpeed: 128 };
    expect(findRoute(scene, anchor, target, travel)!.some(step => step.kind === 'climb-jump')).toBe(true);
    const climbing = findRoute(scene, anchor, target, { ...travel, climbDestination: climb.id })!;
    expect(climbing.length).toBeGreaterThan(0);
    expect(climbing.every(step => step.kind === 'climb' && step.surfaceId === climb.id)).toBe(true);
  });

  it('沿边上移后真实跳回平台，不能凭空制造无出口的支撑', () => {
    const climb = { ...wall(), a: { x: 100, y: 0 }, b: { x: 100, y: 160 } };
    const scene = [platform('source', 0, 80, 100), climb];
    const anchor = { surfaceId: climb.id, sourceRevision: 1, u: 0.5 }, target = { surfaceId: 'source', u: 0.5 };
    const route = findRoute(scene, anchor, target, physics)!;
    expect(route).not.toBeNull();
    const jump = route.find(step => step.kind === 'climb-jump')!;
    expect(jump).toBeDefined();
    const departure = route[route.indexOf(jump) - 1]!;
    const origin = climbRoot(climb, departure.u, height);
    const landing = firstLanding(origin, jump.takeoff!.velocity, scene, physics.gravity, physics.footRadius, undefined, height, undefined, 600);
    expect(landing?.surfaceId).toBe('source');
    expect(landing?.u).toBeCloseTo(jump.u, 7);
    expect(findRoute([climb], anchor, { surfaceId: 'missing', u: 0.5 }, physics)).toBeNull();
  });
});
