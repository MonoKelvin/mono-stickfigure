import { describe, expect, it } from 'vitest';
import { planJump, stepBody } from '../../src/motion/solver';
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

  it('跳跃按下降阶段求解，拒绝能力之外的目标', () => {
    expect(planJump({ x: 0, y: 0 }, { x: 40, y: 0 }, 100, 100, 100)).toEqual({ x: 20, y: -100 });
    expect(planJump({ x: 0, y: 0 }, { x: 1000, y: 0 }, 100, 100, 100)).toBeNull();
    expect(planJump({ x: 0, y: 0 }, { x: 0, y: -100 }, 100, 100, 100)).toBeNull();
  });
});
