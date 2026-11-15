import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SurfaceMeasurement } from '../../src/perception/dom-surfaces';
import type { Viewport } from '../../src/scene/types';

const sensor = vi.hoisted(() => ({ now: 0, cost: 0, calls: [] as Element[] }));
vi.mock('../../src/perception/dom-surfaces', () => ({
  measureBorder: () => null,
  measureFill: (element: Element): SurfaceMeasurement => {
    sensor.calls.push(element);
    sensor.now += sensor.cost;
    const box = element.getBoundingClientRect();
    return { a: { x: box.left, y: box.top }, b: { x: box.right, y: box.top }, available: [{ start: 0, end: 1 }], status: 'valid', clippedByAncestor: false, kind: 'fill', evidence: 'dom-fill', bounds: { left: box.left, right: box.right, top: box.top, bottom: box.bottom } };
  },
}));
vi.mock('../../src/perception/text-surfaces', () => ({ TextMeasurer: class { invalidateFonts() {} parts() { return []; } } }));
import { SurfaceStore } from '../../src/scene/store';

function fixture(count = 1) {
  const doc = { nodeType: 9 } as Document;
  const viewport: Viewport = { left: 0, top: 0, right: 1000, bottom: 800 };
  const store = new SurfaceStore(doc, 1500);
  const boxes = Array.from({ length: count }, (_, i) => ({ left: i, top: 100, width: 100, height: 20 }));
  const elements = boxes.map(box => ({ isConnected: true, getBoundingClientRect: () => ({ ...box, right: box.left + box.width, bottom: box.top + box.height }) }) as unknown as Element);
  store.beginFrame(viewport);
  const ids = elements.map(element => store.measure(element, viewport)!.id);
  return { store, viewport, elements, boxes, ids };
}

beforeEach(() => {
  sensor.now = 0; sensor.cost = 0; sensor.calls.length = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => sensor.now);
});

describe('budgeted scene perception', () => {
  it('120 display frames reuse stable geometry without slowing physics or rendering', () => {
    const f = fixture();
    for (let frame = 1; frame < 120; frame++) {
      sensor.now = frame * 16;
      const viewport = { ...f.viewport };
      f.store.beginFrame(viewport);
      expect(f.store.refresh(f.ids[0]!, viewport)?.status).toBe('valid');
    }
    // Exactly 30 complete sensor reads instead of one per display frame.
    expect(sensor.calls).toHaveLength(30);
  });

  it('geometry, explicit invalidation and viewport changes immediately bypass reuse', () => {
    const f = fixture();
    f.boxes[0]!.top = 140;
    expect(f.store.refresh(f.ids[0]!, f.viewport)?.a.y).toBe(140);
    expect(sensor.calls).toHaveLength(2);
    f.store.invalidate();
    f.store.refresh(f.ids[0]!, f.viewport);
    expect(sensor.calls).toHaveLength(3);
    sensor.now = 16;
    const shifted = { ...f.viewport, left: 1 };
    f.store.beginFrame(shifted);
    f.store.refresh(f.ids[0]!, shifted);
    expect(sensor.calls).toHaveLength(4);
  });

  it('disconnected supports invalidate immediately and direct API queries remain fresh', () => {
    const f = fixture();
    sensor.now = 10;
    f.store.refresh(f.ids[0]!, { ...f.viewport });
    expect(sensor.calls).toHaveLength(2);
    Object.assign(f.elements[0]!, { isConnected: false });
    expect(f.store.refresh(f.ids[0]!, f.viewport)?.status).toBe('invalid');
  });

  it('also budgets skipped distant candidates and resumes from the cursor next frame', () => {
    const f = fixture(40);
    const inspected: string[] = [];
    for (const id of f.ids) {
      const snapshot = f.store.get(id)!;
      const a = snapshot.a;
      Object.defineProperty(snapshot, 'a', { get: () => { inspected.push(id); return a; } });
    }
    vi.spyOn(performance, 'now').mockImplementation(() => sensor.now += 0.25);
    f.store.refreshNearby({ x: 50, y: 1000 }, 5, f.viewport, 1);
    expect(inspected).toHaveLength(3);
    f.store.refreshNearby({ x: 50, y: 1000 }, 5, f.viewport, 1);
    expect(inspected).toHaveLength(6);
    expect(new Set(inspected).size).toBe(6);
  });

  it('one indivisible measurement may overrun, but never starts 32 after the budget is spent', () => {
    const f = fixture(40);
    sensor.calls.length = 0;
    sensor.cost = 2;
    for (let frame = 0; frame < 40; frame++) {
      sensor.now = 100 + frame * 16;
      const viewport = { ...f.viewport };
      f.store.beginFrame(viewport);
      const before = sensor.calls.length;
      f.store.refreshNearby({ x: 50, y: 100 }, 200, viewport, 1);
      expect(sensor.calls.length - before).toBe(1);
    }
    expect(new Set(sensor.calls).size).toBe(40);
    const before = sensor.calls.length;
    f.store.refreshNearby({ x: 50, y: 100 }, 200, f.viewport, 0);
    expect(sensor.calls).toHaveLength(before);
    f.store.clear();
    expect(f.store.get(f.ids[0]!)).toBeNull();
    f.store.refreshNearby({ x: 50, y: 100 }, 200, f.viewport, 1);
  });
});
