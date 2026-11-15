import { measureBorder, measureFill } from '../perception/dom-surfaces';
import type { SurfaceMeasurement } from '../perception/dom-surfaces';
import { TextMeasurer } from '../perception/text-surfaces';
import type { TextPart } from '../perception/text-surfaces';
import type { Point, SurfaceSnapshot, Viewport } from './types';

interface SourceRecord {
  element: Element;
  node: Element | Text;
  part?: TextPart;
  textRevision?: number;
  snapshot: SurfaceSnapshot;
  clippedByAncestor: boolean;
}

interface RefreshMeasurement {
  snapshot: SurfaceSnapshot;
  box: readonly [number, number, number, number];
  measuredAt: number;
}

// Perception is sampled independently from 120 Hz physics / display-rate rendering.
// Geometry and explicit scene invalidation still bypass this short reuse window.
const REFRESH_REUSE_MS = 50;

export class SurfaceStore {
  private readonly records = new Map<string, SourceRecord>();
  private readonly ids = new WeakMap<Node, string>();
  private readonly textGroups = new WeakMap<Text, { revision: number; groups: Map<string, Set<string>> }>();
  private readonly text: TextMeasurer;
  private nextId = 0;
  private nextSourceRevision = 0;
  private walker: TreeWalker | null = null;
  private first: Node | null = null;
  private pendingText: { node: Text; parts: readonly TextPart[]; index: number } | null = null;
  private rescan = true;
  private nextScanAt = 0;
  private frameViewport: Viewport | null = null;
  private frameTime = 0;
  private readonly refreshMeasurements = new Map<string, RefreshMeasurement>();
  private nearbyKeys: string[] | null = null;
  private nearbyCursor = 0;
  private readonly elementMeasurements = new Map<Element, string | null>();
  private readonly textMeasurements = new Map<Text, Map<string, string[]>>();
  readonly pinned = new Set<string>();
  measuredElements = 0;

  constructor(private readonly root: Document | Element | ShadowRoot, private readonly limit: number, private readonly colorTolerance = 0.01) {
    const doc = root.nodeType === 9 ? root as Document : root.ownerDocument!;
    this.text = new TextMeasurer(doc, colorTolerance);
  }

  beginFrame(viewport: Viewport): void {
    const old = this.frameViewport;
    if (!old || old.left !== viewport.left || old.top !== viewport.top || old.right !== viewport.right || old.bottom !== viewport.bottom) this.refreshMeasurements.clear();
    this.frameViewport = viewport;
    this.frameTime = performance.now();
    this.elementMeasurements.clear();
    this.textMeasurements.clear();
    this.measuredElements = 0;
  }

  invalidate(): void {
    this.rescan = true;
    this.refreshMeasurements.clear();
    this.elementMeasurements.clear();
    this.textMeasurements.clear();
  }

  invalidateFonts(): void {
    this.text.invalidateFonts();
    this.invalidate();
  }

  scan(viewport: Viewport, budgetMs: number): void {
    const doc = this.root.nodeType === 9 ? this.root as Document : this.root.ownerDocument!;
    const start = performance.now();
    if (!this.walker) {
      if (!this.rescan && start < this.nextScanAt) return;
      this.rescan = false;
      this.walker = doc.createTreeWalker(this.root, 5, {
        acceptNode: (node) => node.nodeType === 1 && ((node as Element).hasAttribute('data-mono-stickfigure') || ['HEAD', 'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE'].includes((node as Element).tagName)) ? 2 : 1,
      });
      this.first = this.root.nodeType === 1 ? this.root : null;
    }
    do {
      if (this.pendingText) {
        const pending = this.pendingText;
        const part = pending.parts[pending.index++];
        if (part) this.measureTextPart(pending.node, part, viewport);
        if (pending.index >= pending.parts.length) this.pendingText = null;
        continue;
      }
      const node = this.first ?? this.walker.nextNode();
      this.first = null;
      if (!node) {
        this.walker = null;
        this.nextScanAt = performance.now() + 500;
        for (const [id, record] of this.records) {
          if ((!record.node.isConnected || record.snapshot.status === 'invalid') && !this.pinned.has(id)) {
            this.records.delete(id);
            this.refreshMeasurements.delete(id);
            this.nearbyKeys = null;
          }
        }
        break;
      }
      if (node.nodeType === 1) this.measure(node as Element, viewport);
      else if (node.nodeType === 3) {
        const parts = this.text.parts(node as Text);
        if (parts.length) this.pendingText = { node: node as Text, parts, index: 0 };
      }
    } while (performance.now() - start < budgetMs);
  }

  measure(element: Element, viewport: Viewport): SurfaceSnapshot | null {
    const cached = viewport === this.frameViewport;
    if (cached && this.elementMeasurements.has(element)) {
      const id = this.elementMeasurements.get(element);
      return id ? this.get(id) : null;
    }
    this.measuredElements++;
    const knownId = this.ids.get(element);
    const previous = knownId ? this.get(knownId) : null;
    const fill = measureFill(element, viewport, this.colorTolerance);
    // Valid fills already win over borders below; avoid a second expensive
    // painted-edge measurement whose result could never be selected.
    const border = fill?.status === 'valid' ? null : measureBorder(element, viewport, this.colorTolerance);
    const measured = fill?.status === 'valid' ? fill : border?.status === 'valid' ? border
      : previous?.kind === 'border' && border ? border
      : previous?.kind === 'fill' && fill ? fill
      : fill ?? border;
    let snapshot: SurfaceSnapshot | null;
    if (measured) {
      const id = this.sourceId(element);
      snapshot = this.commit(id, id, element, element, measured);
    } else snapshot = knownId ? this.invalidateRecord(knownId) : null;
    if (cached) {
      this.elementMeasurements.set(element, snapshot?.id ?? null);
      if (snapshot) this.rememberRefresh(snapshot, element);
    }
    return snapshot;
  }

  measureTarget(element: Element, viewport: Viewport, footRadius = 0): SurfaceSnapshot | null {
    const usableWidth = (candidate: SurfaceSnapshot) => candidate.status === 'valid' ? Math.max(0, ...candidate.available.map((range) => (range.end - range.start) * (candidate.b.x - candidate.a.x) - footRadius * 2)) : -1;
    const surface = this.measure(element, viewport);
    if (surface && usableWidth(surface) > 0) return surface;
    const walker = element.ownerDocument.createTreeWalker(element, 4);
    let node: Node | null;
    let best: SurfaceSnapshot | null = null;
    let width = 0;
    let count = 0;
    while ((node = walker.nextNode()) && count < 128) {
      for (const part of this.text.parts(node as Text)) {
        for (const candidate of this.measureTextPart(node as Text, part, viewport)) {
          const available = usableWidth(candidate);
          if (available > width) { best = candidate; width = available; }
        }
        if (++count >= 128) break;
      }
    }
    return best ?? surface;
  }

  private sourceId(node: Node): string {
    let id = this.ids.get(node);
    if (!id) { id = `surface-${++this.nextId}`; this.ids.set(node, id); }
    return id;
  }

  private measureTextPart(node: Text, part: TextPart, viewport: Viewport): SurfaceSnapshot[] {
    const cached = viewport === this.frameViewport;
    const group = `${part.start}:${part.end}:${part.contour}`;
    const measurements = cached ? this.textMeasurements.get(node) : undefined;
    const measuredIds = measurements?.get(group);
    if (measuredIds) return measuredIds.flatMap((id) => {
      const snapshot = this.get(id);
      return snapshot ? [snapshot] : [];
    });
    this.measuredElements++;
    const parts = this.text.parts(node);
    const revision = this.text.revision(node);
    let state = this.textGroups.get(node);
    if (!state || state.revision !== revision) {
      for (const [id, record] of this.records) if (record.node === node) this.invalidateRecord(id);
      state = { revision, groups: new Map() };
      this.textGroups.set(node, state);
    }
    const previous = state.groups.get(group);
    const ids = new Set<string>();
    const snapshots: SurfaceSnapshot[] = [];
    if (parts.some((current) => current.start === part.start && current.end === part.end && current.contour === part.contour)) {
      const sourceId = this.sourceId(node);
      for (const measured of this.text.measure(node, part, viewport)) {
        const id = `${sourceId}:text:${measured.feature}`;
        const snapshot = this.commit(id, sourceId, node.parentElement!, node, measured, part, revision);
        if (snapshot) { ids.add(id); snapshots.push(snapshot); }
      }
    }
    if (previous) for (const id of previous) if (!ids.has(id)) this.invalidateRecord(id);
    state.groups.set(group, ids);
    if (cached) {
      const groups = measurements ?? new Map<string, string[]>();
      groups.set(group, [...ids]);
      if (!measurements) this.textMeasurements.set(node, groups);
      for (const snapshot of snapshots) this.rememberRefresh(snapshot, node.parentElement!);
    }
    return snapshots;
  }

  private commit(id: string, sourceId: string, element: Element, node: Element | Text, measured: SurfaceMeasurement, part?: TextPart, textRevision?: number): SurfaceSnapshot | null {
    const previous = this.records.get(id);
    const old = previous?.snapshot;
    const boundsChanged = old?.bounds?.left !== measured.bounds?.left || old?.bounds?.top !== measured.bounds?.top || old?.bounds?.right !== measured.bounds?.right || old?.bounds?.bottom !== measured.bounds?.bottom;
    const changed = !old || boundsChanged || old.a.x !== measured.a.x || old.a.y !== measured.a.y || old.b.x !== measured.b.x || old.b.y !== measured.b.y || old.status !== measured.status || old.kind !== measured.kind || old.available.length !== measured.available.length || old.available.some((range, i) => range.start !== measured.available[i]?.start || range.end !== measured.available[i]?.end);
    const identityChanged = old && ((old.status === 'invalid' && measured.status !== 'invalid') || old.kind !== measured.kind || previous?.textRevision !== textRevision);
    const snapshot: SurfaceSnapshot = {
      id, sourceId,
      sourceRevision: !old || identityChanged ? ++this.nextSourceRevision : old.sourceRevision,
      geometryVersion: (old?.geometryVersion ?? 0) + Number(changed),
      kind: measured.kind, evidence: measured.evidence,
      a: measured.a, b: measured.b, available: measured.available, status: measured.status,
      ...(measured.bounds ? { bounds: measured.bounds } : {}),
    };
    if (!previous && this.records.size >= this.limit) {
      const victim = [...this.records.keys()].find((key) => !this.pinned.has(key));
      if (!victim) return null;
      this.records.delete(victim);
      this.refreshMeasurements.delete(victim);
      this.nearbyKeys = null;
    }
    if (!previous) this.nearbyKeys = null;
    this.records.set(id, { element, node, snapshot, clippedByAncestor: measured.clippedByAncestor, ...(part ? { part, textRevision } : {}) });
    return snapshot;
  }

  private invalidateRecord(id: string): SurfaceSnapshot | null {
    const record = this.records.get(id);
    if (!record) return null;
    this.refreshMeasurements.delete(id);
    if (record.snapshot.status !== 'invalid') record.snapshot = { ...record.snapshot, status: 'invalid', available: [], geometryVersion: record.snapshot.geometryVersion + 1 };
    return record.snapshot;
  }

  private rememberRefresh(snapshot: SurfaceSnapshot, element: Element): void {
    if (snapshot.status !== 'valid' && snapshot.status !== 'offscreen') return;
    const box = element.getBoundingClientRect();
    this.refreshMeasurements.set(snapshot.id, { snapshot, box: [box.left, box.top, box.width, box.height], measuredAt: this.frameTime });
  }

  refresh(id: string, viewport: Viewport): SurfaceSnapshot | null {
    const record = this.records.get(id);
    if (!record) return null;
    if (!record.node.isConnected) return this.invalidateRecord(id);
    const cached = this.refreshMeasurements.get(id);
    if (viewport === this.frameViewport && cached?.snapshot === record.snapshot && this.frameTime - cached.measuredAt < REFRESH_REUSE_MS) {
      const box = record.element.getBoundingClientRect();
      if (box.left === cached.box[0] && box.top === cached.box[1] && box.width === cached.box[2] && box.height === cached.box[3]) return record.snapshot;
      this.elementMeasurements.delete(record.element);
      if (record.part) this.textMeasurements.delete(record.node as Text);
    }
    if (record.part) {
      this.measureTextPart(record.node as Text, record.part, viewport);
      return this.records.get(id)?.snapshot ?? null;
    }
    return this.measure(record.element, viewport);
  }

  refreshNearby(point: Point, radius: number, viewport: Viewport, budgetMs = Infinity): void {
    if (!(budgetMs > 0)) return;
    const started = performance.now();
    const keys = this.nearbyKeys ??= [...this.records.keys()];
    let count = 0;
    const seen = new Set<string>();
    for (let visited = 0; visited < keys.length; visited++) {
      if (performance.now() - started >= budgetMs) break;
      const id = keys[this.nearbyCursor++ % keys.length]!;
      const record = this.records.get(id);
      if (!record) continue;
      const { a, b, sourceId } = record.snapshot;
      if (point.x + radius < a.x || point.x - radius > b.x || Math.abs(point.y - a.y) > radius) continue;
      const key = record.part ? `${sourceId}:${record.part.start}:${record.part.end}` : id;
      if (seen.has(key)) continue;
      seen.add(key);
      this.refresh(id, viewport);
      // A single DOM measurement cannot be preempted; never start another after
      // its budget is spent. The cursor gives later surfaces a turn next frame.
      if (++count >= 32 || performance.now() - started >= budgetMs) break;
    }
    if (keys.length) this.nearbyCursor %= keys.length;
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
    this.elementMeasurements.clear();
    this.textMeasurements.clear();
    this.frameViewport = null;
    this.refreshMeasurements.clear();
    this.nearbyKeys = null;
    this.nearbyCursor = 0;
    this.walker = null;
    this.first = null;
    this.pendingText = null;
  }
}
