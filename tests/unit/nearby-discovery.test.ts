import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SurfaceMeasurement } from '../../src/perception/dom-surfaces';
import type { Viewport } from '../../src/scene/types';

const sensor = vi.hoisted(() => ({ now: 0, calls: [] as Element[], text: [] as number[] }));
vi.mock('../../src/perception/dom-surfaces', () => ({
  measureBorder: () => null,
  measureClimbEdges: () => [],
  measureFill: (el: Element): SurfaceMeasurement => {
    sensor.now += 2; sensor.calls.push(el);
    const b = el.getBoundingClientRect();
    return { a: { x: b.left, y: b.top }, b: { x: b.right, y: b.top }, available: [{ start: 0, end: 1 }], status: 'valid', clippedByAncestor: false, kind: 'fill', evidence: 'dom-fill' };
  },
}));
vi.mock('../../src/perception/text-surfaces', () => ({ TextMeasurer: class {
  invalidateFonts() {}
  parts() { return Array.from({ length: 100 }, (_, i) => ({ start: i * 5, end: i * 5 + 4, ordinal: i, revision: 1 })); }
  revision() { return 1; }
  measure(_node: Text, part: { ordinal: number }) {
    sensor.now += 2; sensor.text.push(part.ordinal);
    return [{ feature: `${part.ordinal}:0`, a: { x: 40, y: 105 }, b: { x: 80, y: 105 }, available: [{ start: 0, end: 1 }], status: 'valid', clippedByAncestor: false, kind: 'text', evidence: 'text-metric' }];
  }
} }));
import { SurfaceStore } from '../../src/scene/store';

const viewport: Viewport = { left: 0, top: 0, right: 1000, bottom: 800 };
function fixture() {
  const elements: Element[] = [];
  const doc = { nodeType: 9, elementsFromPoint: vi.fn(() => elements), caretRangeFromPoint: vi.fn(() => null) } as unknown as Document;
  const store = new SurfaceStore(doc, 1500);
  const make = (excluded = false) => ({ nodeType: 1, tagName: 'DIV', isConnected: true, firstChild: null, closest: () => excluded ? {} : null,
    getBoundingClientRect: () => ({ left: 20, right: 120, top: 100, bottom: 120, width: 100, height: 20 }) }) as unknown as Element;
  store.beginFrame(viewport);
  return { store, doc, elements, make };
}
beforeEach(() => {
  sensor.now = 0; sensor.calls.length = 0; sensor.text.length = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => sensor.now);
});
describe('foreground DOM discovery', () => {
  it('discovers unseen nearby elements without running the global walker, resumes under budget', () => {
    const f = fixture(); f.elements.push(f.make(), f.make());
    f.store.discoverNearby({ x: 50, y: 100 }, 100, viewport, 1);
    expect(sensor.calls).toHaveLength(1);
    expect(f.store.snapshots()).toHaveLength(1);
    f.store.discoverNearby({ x: 50, y: 100 }, 100, viewport, 1);
    expect(sensor.calls).toHaveLength(2);
    expect(f.store.snapshots()).toHaveLength(2);
    f.store.discoverNearby({ x: 50, y: 100 }, 100, viewport, 0);
    expect(sensor.calls).toHaveLength(2);
  });
  it('prioritizes the caret-hit words of a long paragraph, not just its beginning', () => {
    const f = fixture(); const parent = f.make();
    const node = { nodeType: 3, isConnected: true, parentElement: parent } as unknown as Text;
    vi.mocked(f.doc.caretRangeFromPoint).mockReturnValue({ startContainer: node, startOffset: 300 } as unknown as Range);
    f.store.discoverNearby({ x: 50, y: 100 }, 100, viewport, 1);
    expect(sensor.text).toEqual([56]);
    expect(f.store.snapshots()[0]?.kind).toBe('text');
  });
  it('does not measure plugin overlays or candidates outside an element-scoped root', () => {
    const f = fixture(); f.elements.push(f.make(true));
    f.store.discoverNearby({ x: 50, y: 100 }, 100, viewport, 1);
    expect(sensor.calls).toHaveLength(0);
    const root = { nodeType: 1, ownerDocument: f.doc, contains: () => false } as unknown as Element;
    const scoped = new SurfaceStore(root, 1500); f.elements.push(f.make());
    scoped.discoverNearby({ x: 50, y: 100 }, 100, viewport, 1);
    expect(sensor.calls).toHaveLength(0);
  });
  it('keeps nearby platforms when distant global candidates compete for capacity', () => {
    const f = fixture(); const store = new SurfaceStore(f.doc, 1); store.beginFrame(viewport);
    f.elements.push(f.make());
    store.discoverNearby({ x: 50, y: 100 }, 100, viewport, 1);
    const first = store.snapshots()[0]!;
    const distant = f.make();
    Object.assign(distant, { getBoundingClientRect: () => ({ left: 700, right: 800, top: 700, bottom: 720, width: 100, height: 20 }) });
    expect(store.measure(distant, viewport)).toBeNull();
    expect(store.get(first.id)).toBe(first);
    store.pinned.add(first.id);
    expect(store.measure(f.make(), { ...viewport })).toBeNull();
    expect(store.get(first.id)).toBe(first);
  });
  it('completed sampling sleeps, then invalidation immediately enables rediscovery', () => {
    const f = fixture();
    f.store.discoverNearby({ x: 50, y: 100 }, 100, viewport, 1);
    const calls = vi.mocked(f.doc.elementsFromPoint).mock.calls.length;
    sensor.now = 16;
    f.store.discoverNearby({ x: 50, y: 100 }, 100, viewport, 1);
    expect(f.doc.elementsFromPoint).toHaveBeenCalledTimes(calls);
    f.elements.push(f.make()); f.store.invalidate();
    f.store.discoverNearby({ x: 50, y: 100 }, 100, viewport, 1);
    expect(sensor.calls).toHaveLength(1);
  });
});
