import { describe, expect, it } from 'vitest';
import { fromClient, toClient } from '../../src/coordinates/frames';

describe('运动参考系', () => {
  it('文档滚动只补偿一次', () => {
    const frame = { offset: { x: -30, y: -200 }, scale: { x: 1, y: 1 } };
    const point = { x: 100, y: 500 };
    expect(toClient(point, frame)).toEqual({ x: 70, y: 300 });
    expect(fromClient(toClient(point, frame), frame)).toEqual(point);
  });

  it('缩放与偏移可逆，换系保留根而不是接触点', () => {
    const frame = { offset: { x: 15, y: -90 }, scale: { x: 2, y: 0.5 } };
    const previousRoot = { x: 100, y: 120 };
    expect(toClient(fromClient(previousRoot, frame), frame)).toEqual(previousRoot);
  });
});
