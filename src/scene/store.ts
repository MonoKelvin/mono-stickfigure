import { measureBorder } from '../perception/dom-surfaces';
import type { Point, SurfaceSnapshot, Viewport } from './types';

interface SourceRecord {
  element: Element;
  snapshot: SurfaceSnapshot;
  clippedByAncestor: boolean;
}

export class SurfaceStore {
  private readonly records = new Map<string, SourceRecord>();
  private readonly ids = new WeakMap<Element, string>();
  private nextId = 0;
  private walker: TreeWalker | null = null;
  private first: Element | null = null;
  private rescan = true;
  private nextScanAt = 0;
  readonly pinned = new Set<string>();
  measuredElements = 0;

  constructor(private readonly root: Document | Element | ShadowRoot, private readonly limit: number) {}

  invalidate(): void {
    this.rescan = true;
  }

  scan(viewport: Viewport, budgetMs: number): void {
    const doc = this.root.nodeType === 9 ? this.root as Document : this.root.ownerDocument!;
    const start = performance.now();
    if (!this.walker) {
      if (!this.rescan && start < this.nextScanAt) return;
      this.rescan = false;
      this.walker = doc.createTreeWalker(this.root, 1, {
        acceptNode: (node) => (node as Element).hasAttribute('data-mono-stickfigure') ? 2 : 1,
      });
      this.first = this.root.nodeType === 1 ? this.root as Element : null;
    }
    do {
      const element = this.first ?? this.walker.nextNode() as Element | null;
      this.first = null;
      if (!element) {
        this.walker = null;
        this.nextScanAt = performance.now() + 500;
        for (const [id, record] of this.records) {
          if ((!record.element.isConnected || record.snapshot.status === 'invalid') && !this.pinned.has(id)) this.records.delete(id);
        }
        break;
      }
      this.measure(element, viewport);
    } while (performance.now() - start < budgetMs);
  }

  measure(element: Element, viewport: Viewport): SurfaceSnapshot | null {
    this.measuredElements++;
    const knownId = this.ids.get(element);
    const previous = knownId ? this.records.get(knownId) : undefined;
    const measured = measureBorder(element, viewport);
    if (!measured) {
      if (previous && previous.snapshot.status !== 'invalid') {
        previous.snapshot = { ...previous.snapshot, status: 'invalid', available: [], geometryVersion: previous.snapshot.geometryVersion + 1 };
      }
      return previous?.snapshot ?? null;
    }
    const id = knownId ?? `surface-${++this.nextId}`;
    this.ids.set(element, id);
    const old = previous?.snapshot;
    const changed = !old || old.a.x !== measured.a.x || old.a.y !== measured.a.y || old.b.x !== measured.b.x || old.status !== measured.status || old.available[0]?.start !== measured.available[0]?.start || old.available[0]?.end !== measured.available[0]?.end;
    const snapshot: SurfaceSnapshot = {
      id,
      sourceId: id,
      sourceRevision: (old?.sourceRevision ?? 1) + (old?.status === 'invalid' && measured.status !== 'invalid' ? 1 : 0),
      geometryVersion: (old?.geometryVersion ?? 0) + Number(changed),
      kind: 'border',
      ...measured,
      evidence: 'dom-painted-edge',
    };
    if (!previous && this.records.size >= this.limit) {
      const victim = [...this.records.keys()].find((key) => !this.pinned.has(key));
      if (!victim) return null;
      this.records.delete(victim);
    }
    this.records.set(id, { element, snapshot, clippedByAncestor: measured.clippedByAncestor });
    return snapshot;
  }

  refresh(id: string, viewport: Viewport): SurfaceSnapshot | null {
    const record = this.records.get(id);
    return record ? this.measure(record.element, viewport) : null;
  }

  refreshNearby(point: Point, radius: number, viewport: Viewport): void {
    let count = 0;
    for (const record of this.records.values()) {
      const { a, b } = record.snapshot;
      if (point.x + radius < a.x || point.x - radius > b.x || Math.abs(point.y - a.y) > radius) continue;
      this.measure(record.element, viewport);
      if (++count >= 32) break;
    }
  }

  get(id: string): SurfaceSnapshot | null {
    return this.records.get(id)?.snapshot ?? null;
  }

  element(id: string): Element | null {
    return this.records.get(id)?.element ?? null;
  }

  clippedByAncestor(id: string): boolean {
    return this.records.get(id)?.clippedByAncestor ?? false;
  }

  snapshots(): SurfaceSnapshot[] {
    return [...this.records.values()].map((record) => record.snapshot);
  }

  clear(): void {
    this.records.clear();
    this.pinned.clear();
    this.walker = null;
    this.first = null;
  }
}
