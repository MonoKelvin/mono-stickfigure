import { describe, expect, it } from 'vitest';
import { planJump, stepBody, stepWalk } from '../../src/motion/solver';
import type { Body, SurfaceSnapshot } from '../../src/scene/types';

const platform = (y: number, id = 'floor'): SurfaceSnapshot => ({
  id, sourceId: id, sourceRevision: 1, geometryVersion: 1, kind: 'border',
  a: { x: 0, y }, b: { x: 100, y }, available: [{ start: 0, end: 1 }], status: 'valid', evidence: 'dom-painted-edge',
});
const falling: Body = { position: { x: 50, y: 0 }, velocity: { x: 0, y: 0 } };

describe('运动与接触', () => {
  it('扫掠捕获薄平台并优先接触最近平台', () => {
    const result = stepBody(falling, [platform(10, 'lower'), platform(5, 'upper')], 0.5, 100, 1000, 4);
    expect(result.landing?.surfaceId).toBe('upper');
    expect(result.body.position).toEqual({ x: 50, y: 5 });
    expect(result.body.velocity.y).toBe(0);
    expect(falling.position.y).toBe(0);
  });

  it('从下方上升不能吸附', () => {
    const body = { position: { x: 50, y: 20 }, velocity: { x: 0, y: -100 } };
    expect(stepBody(body, [platform(15)], 0.1, 100, 1000).landing).toBeNull();
  });

  it('不接触隐藏平台或裁剪掉的区间', () => {
    const clipped = { ...platform(5), available: [{ start: 0, end: 0.4 }] };
    expect(stepBody(falling, [clipped], 0.5, 100, 1000).landing).toBeNull();
    expect(stepBody(falling, [{ ...platform(5), status: 'invalid' }], 0.5, 100, 1000).landing).toBeNull();
  });

  it('支撑区间必须容纳脚宽', () => {
    const edge = { position: { x: 2, y: 0 }, velocity: { x: 0, y: 0 } };
    expect(stepBody(edge, [platform(5)], 0.5, 100, 1000, 4).landing).toBeNull();
  });

  it('终端速度下仍可找到接触', () => {
    const body = { position: { x: 50, y: 0 }, velocity: { x: 0, y: 100 } };
    const result = stepBody(body, [platform(10)], 0.2, 100, 100);
    expect(result.landing?.impactSpeed).toBe(100);
    expect(result.body.position.y).toBe(10);
    expect(stepBody(body, [], 1, 100, 100).body.position.y).toBe(100);
  });

  it('无阻力重力积分符合位移和速度公式且不依赖子步数量', () => {
    const initial: Body = { position: { x: 10, y: 30 }, velocity: { x: 40, y: -300 } };
    const duration = 0.25;
    const expected = stepBody(initial, [], duration, 980).body;
    expect(expected.position.x).toBeCloseTo(20);
    expect(expected.position.y).toBeCloseTo(30 - 300 * duration + 980 * duration ** 2 / 2);
    expect(expected.velocity.y).toBeCloseTo(-300 + 980 * duration);
    for (const steps of [15, 30, 60]) {
      let body = initial;
      for (let i = 0; i < steps; i++) body = stepBody(body, [], duration / steps, 980).body;
      expect(body.position.x).toBeCloseTo(expected.position.x, 8);
      expect(body.position.y).toBeCloseTo(expected.position.y, 8);
      expect(body.velocity.y).toBeCloseTo(expected.velocity.y, 8);
    }
  });

  it('跳跃顶点由重力与起跳速度确定，机械能保持', () => {
    const gravity = 980;
    const upward = Math.sqrt(2 * gravity * 52);
    const initial = { position: { x: 0, y: 0 }, velocity: { x: 60, y: -upward } };
    const apex = stepBody(initial, [], upward / gravity, gravity).body;
    expect(apex.velocity.y).toBeCloseTo(0, 8);
    expect(apex.position.y).toBeCloseTo(-52, 8);
    let body = initial;
    for (let i = 0; i < 120; i++) {
      body = stepBody(body, [], 1 / 120, gravity).body;
      expect(body.velocity.y ** 2 / 2 - gravity * body.position.y).toBeCloseTo(upward ** 2 / 2, 6);
    }
  });

  it('行走具有连续加速并只累计相对平台的位移', () => {
    const body = { position: { x: 50, y: 0 }, velocity: { x: 0, y: 0 } };
    const result = stepWalk(body, platform(0), 0.5, 30, 120, 0.5, 5);
    expect(result.body.velocity.x).toBeCloseTo(30);
    expect(result.distance).toBeCloseTo(11.25);
    expect(result.u).toBeCloseTo(0.6125);
    const shifted = { ...platform(40), a: { x: 200, y: 40 }, b: { x: 300, y: 40 } };
    const carried = stepWalk(body, shifted, 0.5, 30, 120, 0.5, 5);
    expect(carried.distance).toBeCloseTo(result.distance);
    expect(carried.body.position).toEqual({ x: 261.25, y: 40 });
  });

  it('制动不瞬间改变速度，抵达平台边缘时不越过有效脚宽', () => {
    const body = { position: { x: 50, y: 0 }, velocity: { x: 30, y: 0 } };
    const brake = stepWalk(body, platform(0), 0.5, 0, 120, 0.1, 5);
    expect(brake.body.velocity.x).toBeCloseTo(18);
    expect(brake.distance).toBeCloseTo(2.4);
    const edge = stepWalk(body, platform(0), 0.9, 30, 120, 1, 5);
    expect(edge.body.position.x).toBeCloseTo(95);
    expect(edge.body.velocity.x).toBe(0);
    expect(edge.edge).toBe(1);
    const clipped = { ...platform(0), available: [{ start: 0.2, end: 0.6 }] };
    const left = stepWalk(body, clipped, 0.4, -30, 120, 2, 5);
    expect(left.u).toBeCloseTo(0.25);
    expect(left.edge).toBe(-1);
  });

  it('跳跃按下降阶段求解，拒绝能力之外的目标', () => {
    expect(planJump({ x: 0, y: 0 }, { x: 40, y: 0 }, 100, 100, 100)).toEqual({ x: 20, y: -100 });
    expect(planJump({ x: 0, y: 0 }, { x: 1000, y: 0 }, 100, 100, 100)).toBeNull();
    expect(planJump({ x: 0, y: 0 }, { x: 0, y: -100 }, 100, 100, 100)).toBeNull();
  });
});
