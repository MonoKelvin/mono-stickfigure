import { describe, expect, it } from 'vitest';
import { createPose, samplePose, JOINT } from '../../src/animation/rig';
import type { Pose } from '../../src/animation/rig';
import { CanvasRenderer } from '../../src/rendering/canvas';
import type { Appearance, ActionId } from '../../src/types';

interface Operation { name: string; args: unknown[] }

function fixture(dpr = 1, options: Partial<Appearance> = {}) {
  const appearance: Appearance = { height: 24, color: '#123456', lineWidth: 2, head: 'circle', ...options };
  const calls: Operation[] = [];
  const contextWrites: Operation[] = [];
  const styleWrites: Operation[] = [];
  const resizeWrites: Operation[] = [];
  const attrs = new Map<string, string>();
  const context = new Proxy<Record<string, unknown>>({}, {
    get: (target, key: string) => target[key] ?? ((...args: unknown[]) => { calls.push({ name: key, args }); }),
    set: (target, key: string, value: unknown) => { contextWrites.push({ name: key, args: [value] }); target[key] = value; return true; },
  });
  const style = new Proxy<Record<string, unknown>>({}, {
    set: (target, key: string, value: unknown) => { styleWrites.push({ name: key, args: [value] }); target[key] = value; return true; },
  });
  let width = 0, height = 0;
  const element = {
    style,
    setAttribute: (key: string, value: string) => attrs.set(key, value),
    getContext: () => context,
    remove: () => calls.push({ name: 'remove', args: [] }),
    get width() { return width; },
    set width(value: number) { width = value; resizeWrites.push({ name: 'width', args: [value] }); },
    get height() { return height; },
    set height(value: number) { height = value; resizeWrites.push({ name: 'height', args: [value] }); },
  };
  const view = { devicePixelRatio: dpr };
  const doc = { defaultView: view, createElement: () => element } as unknown as Document;
  const mount = { append: () => {} } as unknown as HTMLElement;
  const renderer = new CanvasRenderer(doc, mount, appearance, 2);
  // Constructor-only CSS declarations are not recurring frame work.
  styleWrites.length = 0;
  const count = (name: string) => calls.filter(call => call.name === name).length;
  return { renderer, appearance, calls, count, contextWrites, styleWrites, resizeWrites, view, element, attrs };
}

function pose(height = 24): Pose {
  const result = createPose();
  samplePose(result, { height, action: 'idle', time: 1, dt: 1, facing: 1, verticalVelocity: 0, landProgress: 0 });
  return result;
}

describe('局部 Canvas 渲染缓存', () => {
  it('120 个相同帧只清屏绘制一次，且不反复写 CSS、变换或尺寸', () => {
    const f = fixture(2);
    const p = pose();
    for (let frame = 0; frame < 120; frame++) {
      f.renderer.draw({ x: 120.25, y: 90.5 }, p);
      f.renderer.setVisible(true);
    }
    expect(f.count('clearRect')).toBe(1);
    expect(f.count('stroke')).toBe(1);
    expect(f.count('fill')).toBe(1);
    expect(f.count('setTransform')).toBe(1);
    expect(f.count('translate')).toBe(0);
    expect(f.resizeWrites).toHaveLength(2);
    expect(f.contextWrites).toHaveLength(6);
    expect(f.styleWrites).toEqual([
      { name: 'transform', args: ['translate(84.25px, 43.699999999999996px)'] },
      { name: 'display', args: ['block'] },
    ]);
    expect(f.attrs.get('data-mono-stickfigure')).toBe('');
    expect(f.attrs.get('aria-hidden')).toBe('true');
    expect(f.element.style.pointerEvents).toBe('none');
  });

  it('相同姿态移动只平移已有位图，保持 client 子像素坐标', () => {
    const f = fixture(1.25);
    const p = pose();
    for (let frame = 0; frame < 120; frame++) f.renderer.draw({ x: 100.125 + frame / 8, y: -0.25 }, p);
    expect(f.count('clearRect')).toBe(1);
    expect(f.styleWrites).toHaveLength(120);
    const matrix = f.calls.find(call => call.name === 'setTransform')!.args as number[];
    expect(matrix.slice(0, 5)).toEqual([1.25, 0, 0, 1.25, 45]);
    expect(matrix[5]).toBeCloseTo(58.5, 12);
    const transform = String(f.element.style.transform);
    const xy = transform.match(/^translate\(([-\d.]+)px, ([-\d.]+)px\)$/)!;
    expect(Number(xy[1]) + 36).toBeCloseTo(100.125 + 119 / 8, 12);
    expect(Number(xy[2]) + 46.8).toBeCloseTo(-0.25, 12);
    expect(f.element.width).toBe(90);
    expect(f.element.height).toBe(90);
  });

  it('每帧变化的姿态照常绘制，但 Canvas state 和样式只设置一次', () => {
    const f = fixture();
    const p = pose();
    for (let frame = 0; frame < 120; frame++) {
      p.joints[JOINT.leftHand * 2] = frame / 16;
      f.renderer.draw({ x: 80, y: 60 }, p);
      f.renderer.setVisible(true);
    }
    expect(f.count('clearRect')).toBe(120);
    expect(f.count('stroke')).toBe(120);
    expect(f.count('fill')).toBe(120);
    expect(f.count('setTransform')).toBe(1);
    expect(f.contextWrites).toHaveLength(6);
    expect(f.styleWrites).toHaveLength(2);
    expect(f.resizeWrites).toHaveLength(2);
  });

  it('原地变更脚角度、朝向、头半径、外观都会使缓存失效', () => {
    const f = fixture();
    const p = pose();
    const draw = () => f.renderer.draw({ x: 80, y: 60 }, p);
    draw();
    p.footAngles[1] = 0.3; draw();
    p.facingScale = -1; draw();
    p.headRadius += 0.5; draw();
    f.appearance.color = '#ffffff'; draw();
    f.appearance.lineWidth = 3; draw();
    f.appearance.head = 'square'; draw();
    f.appearance.height = 25; draw();
    expect(f.count('clearRect')).toBe(8);
    expect(f.count('rect')).toBe(2);
    expect(f.count('arc')).toBe(6);
    expect(f.contextWrites.filter(write => write.name === 'strokeStyle')).toHaveLength(2);
    expect(f.contextWrites.filter(write => write.name === 'lineWidth')).toHaveLength(2);
  });

  it('DPR/页面缩放改变时重建位图和状态；超过上限不无意义 resize', () => {
    const f = fixture(1, { height: 16.1 });
    const p = pose(16.1);
    f.renderer.draw({ x: 0.125, y: 100 }, p);
    f.view.devicePixelRatio = 1.25;
    f.renderer.draw({ x: 0.125, y: 100 }, p);
    expect(f.element.width).toBe(Math.ceil(49 * 1.25));
    expect(f.element.height).toBe(Math.ceil(49 * 1.25));
    f.view.devicePixelRatio = 3;
    f.renderer.draw({ x: 0.125, y: 100 }, p);
    f.view.devicePixelRatio = 4;
    f.renderer.draw({ x: 0.125, y: 100 }, p);
    expect(f.element.width).toBe(98);
    expect(f.count('clearRect')).toBe(3);
    expect(f.count('setTransform')).toBe(3);
    expect(f.resizeWrites).toHaveLength(6);
    expect(f.contextWrites).toHaveLength(18);
    expect(f.styleWrites).toHaveLength(1);
  });

  it('反复显隐不重复写 display；显示后保留位图，destroy 释放位图', () => {
    const f = fixture();
    const p = pose();
    f.renderer.setVisible(false);
    f.renderer.draw({ x: 0, y: 0 }, p);
    f.renderer.setVisible(true);
    f.renderer.setVisible(true);
    f.renderer.setVisible(false);
    f.renderer.setVisible(false);
    f.renderer.setVisible(true);
    f.renderer.draw({ x: 0, y: 0 }, p);
    expect(f.styleWrites.filter(write => write.name === 'display').map(write => write.args[0])).toEqual(['block', 'none', 'block']);
    expect(f.count('clearRect')).toBe(1);
    f.renderer.destroy();
    expect(f.count('remove')).toBe(1);
    expect(f.element.width).toBe(0);
    expect(f.element.height).toBe(0);
  });

  it('保持完整局部画布：采样动作、头部和脚端不会因缓存变更被裁切', () => {
    const actions: ActionId[] = ['idle', 'walk', 'run', 'sprint', 'turn', 'wave', 'crouch', 'rest', 'prone', 'stand-up', 'jump', 'run-jump', 'running-long-jump', 'fall', 'land-soft', 'roll', 'sit', 'question', 'run-in-place', 'climb'];
    for (const h of [12, 16.1, 24, 64]) {
      const f = fixture(1.25, { height: h, lineWidth: h / 4, head: 'square' });
      const p = createPose();
      const size = Math.ceil(h * 3), center = size / 2, baseline = size * 0.65;
      for (const action of actions) {
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (let frame = 0; frame < 120; frame++) {
          samplePose(p, { height: h, action, time: frame / 120, clock: frame / 120, dt: 1 / 120,
            facing: frame < 60 ? 1 : -1, verticalVelocity: frame < 60 ? -80 : 80,
            landProgress: frame / 120, distance: frame * h / 30, horizontalSpeed: 4 * h,
            climb: { normal: { x: frame < 60 ? -Math.cos(0.15) : Math.cos(0.15), y: Math.sin(0.15) }, distance: frame * h / 120 } });
          f.calls.length = 0;
          f.renderer.draw({ x: 100.125, y: 200.25 }, p);
          for (const call of f.calls) {
            if (call.name === 'moveTo' || call.name === 'lineTo') {
              const [x, y] = call.args as number[];
              minX = Math.min(minX, x! + center - h / 8);
              maxX = Math.max(maxX, x! + center + h / 8);
              minY = Math.min(minY, y! + baseline - h / 8);
              maxY = Math.max(maxY, y! + baseline + h / 8);
            } else if (call.name === 'rect') {
              const [x, y, width, height] = call.args as number[];
              minX = Math.min(minX, x! + center);
              maxX = Math.max(maxX, x! + width! + center);
              minY = Math.min(minY, y! + baseline);
              maxY = Math.max(maxY, y! + height! + baseline);
            }
          }
        }
        expect(minX, `${h}px ${action} left`).toBeGreaterThanOrEqual(0);
        expect(maxX, `${h}px ${action} right`).toBeLessThanOrEqual(size);
        expect(minY, `${h}px ${action} top`).toBeGreaterThanOrEqual(0);
        expect(maxY, `${h}px ${action} bottom`).toBeLessThanOrEqual(size);
      }
    }
  });
});
