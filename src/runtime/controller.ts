import { createPose, samplePose } from '../animation/rig';
import { fromClient, isViewportMount, readFrame, readViewport, selectFrame, toClient } from '../coordinates/frames';
import type { MotionFrame } from '../coordinates/frames';
import { planJump, stepBody } from '../motion/solver';
import { CanvasRenderer } from '../rendering/canvas';
import { SurfaceStore } from '../scene/store';
import type { Anchor, Body, Point, SurfaceSnapshot, Viewport } from '../scene/types';
import type { ActionId, ActionOptions, ActionResult, Appearance, Diagnostics, LifecycleStatus, PauseReason, PlaceResult, PlaceTarget, StartResult, StickFigure, StickFigureEvents, StickFigureOptions, StickFigureSnapshot } from '../types';
import { FixedStepClock } from './scheduler';

const ACTIONS: readonly ActionId[] = ['idle', 'jump', 'fall', 'land-soft'];
type PendingEvent = { type: keyof StickFigureEvents; payload: StickFigureEvents[keyof StickFigureEvents] };

function positive(value: number, name: string): number {
  if (!Number.isFinite(value) || value <= 0) throw new RangeError(`${name} 必须是有限正数`);
  return value;
}

export class StickFigureController implements StickFigure {
  private options: StickFigureOptions;
  private readonly appearance: Appearance;
  private readonly budget: number;
  private readonly limit: number;
  private readonly maxDpr: number;
  private seed: number;
  private doc: Document | null = null;
  private win: Window | null = null;
  private root: Document | Element | ShadowRoot | null = null;
  private store: SurfaceStore | null = null;
  private renderer: CanvasRenderer | null = null;
  private readonly pose = createPose();
  private readonly clock = new FixedStepClock();
  private status: LifecycleStatus = 'created';
  private readonly pauses = new Set<PauseReason>();
  private body: Body | null = null;
  private support: Anchor | null = null;
  private motionFrame: MotionFrame | null = null;
  private localPosition: Point | null = null;
  private action: ActionId = 'idle';
  private actionTime = 0;
  private targetId: string | null = null;
  private ignoredId: string | null = null;
  private ignoredTime = 0;
  private entering = false;
  private enteringTime = 0;
  private unknownFrames = 0;
  private viewChanged = false;
  private reduced = false;
  private facing: 1 | -1 = 1;
  private raf: number | null = null;
  private timer: number | null = null;
  private previousRender: number | null = null;
  private startedAt = 0;
  private startPromise: Promise<StartResult> | null = null;
  private startResolve: ((result: StartResult) => void) | null = null;
  private startReject: ((reason: Error) => void) | null = null;
  private pendingAction: ((result: ActionResult) => void) | null = null;
  private readonly cleanup: (() => void)[] = [];
  private readonly listeners = new Map<keyof StickFigureEvents, Set<(payload: unknown) => void>>();
  private events: PendingEvent[] = [];
  private metrics: Diagnostics = { frameMs: 0, scanMs: 0, measuredElements: 0, surfaceCount: 0, droppedTimeMs: 0 };

  constructor(options: StickFigureOptions = {}) {
    this.options = { ...options };
    this.appearance = { height: 32, color: '#2455d6', lineWidth: 2, head: 'circle', ...options.appearance };
    positive(this.appearance.height, 'appearance.height');
    positive(this.appearance.lineWidth, 'appearance.lineWidth');
    if (this.appearance.height > 256 || this.appearance.lineWidth > this.appearance.height / 4) throw new RangeError('人物高度应不超过 256，线宽应不超过高度的四分之一');
    if (!['circle', 'square'].includes(this.appearance.head)) throw new TypeError('当前仅支持 circle / square 头型');
    this.budget = positive(options.performance?.scanBudgetMs ?? 2, 'scanBudgetMs');
    this.limit = positive(options.performance?.maxSurfaces ?? 1500, 'maxSurfaces');
    if (!Number.isInteger(this.limit)) throw new RangeError('maxSurfaces 必须是整数');
    this.maxDpr = positive(options.performance?.maxDpr ?? 2, 'maxDpr');
    if (!Number.isFinite(options.seed ?? 1)) throw new RangeError('seed 必须是有限数值');
    this.seed = (options.seed ?? Math.floor(Math.random() * 0xffffffff)) >>> 0;
  }

  start(): Promise<StartResult> {
    if (this.status === 'destroyed') return Promise.reject(new Error('DESTROYED: 实例已销毁'));
    if (this.startPromise) return this.startPromise;
    const promise = new Promise<StartResult>((resolve, reject) => { this.startResolve = resolve; this.startReject = reject; });
    this.startPromise = promise;
    try {
      const root = this.options.root ?? (typeof document !== 'undefined' ? document : null);
      if (!root) throw new Error('BROWSER_REQUIRED: start() 需要浏览器 DOM 环境');
      const doc = root.nodeType === 9 ? root as Document : root.ownerDocument;
      if (!doc?.defaultView || !doc.body || !root.isConnected) throw new Error('DOCUMENT_NOT_READY: 请在页面挂载后启动');
      const mount = this.options.mount ?? doc.body;
      if (mount.ownerDocument !== doc || !mount.isConnected || !isViewportMount(mount)) throw new Error('UNSUPPORTED_MOUNT: 挂载点必须连接到同一文档，且不能位于变换或隔离的包含块内');
      const colorProbe = doc.createElement('span');
      colorProbe.style.color = this.appearance.color;
      if (!colorProbe.style.color) throw new TypeError('appearance.color 不是有效颜色');
      this.doc = doc;
      this.win = doc.defaultView;
      this.root = root;
      this.store = new SurfaceStore(root, this.limit);
      this.renderer = new CanvasRenderer(doc, mount, this.appearance, this.maxDpr);
      this.motionFrame = { kind: 'document', document: doc };
      this.startedAt = performance.now();
      this.bindEvents();
      this.setStatus('starting');
      if (doc.hidden) this.pauses.add('document-hidden');
      if (this.pauses.size) { this.finishStart('paused'); this.sleep(); }
      else this.schedule();
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      const reject = this.startReject;
      this.startResolve = null;
      this.startReject = null;
      this.startPromise = null;
      this.releaseResources();
      this.setStatus('created');
      reject?.(failure);
    }
    this.flushEvents();
    return promise;
  }

  pause(): void {
    if (this.status === 'destroyed') return;
    this.pauses.add('user');
    if (this.doc) { this.finishStart('paused'); this.sleep(); }
    this.flushEvents();
  }

  resume(): void {
    if (this.status === 'destroyed') return;
    this.pauses.delete('user');
    this.clock.reset();
    this.schedule();
  }

  destroy(): void {
    if (this.status === 'destroyed') return;
    this.finishAction('interrupted', 'destroyed');
    this.startReject?.(new Error('ABORTED: 启动已被销毁操作取消'));
    this.startResolve = null;
    this.startReject = null;
    this.releaseResources();
    this.options = {};
    this.body = null;
    this.support = null;
    this.localPosition = null;
    this.motionFrame = null;
    this.pauses.clear();
    this.setStatus('destroyed');
    this.flushEvents();
    this.listeners.clear();
    this.events = [];
  }

  async place(target: PlaceTarget): Promise<PlaceResult> {
    if (!this.doc || !this.store || this.status === 'destroyed') return { status: 'rejected', reason: 'not-started' };
    const resolved = this.resolveTarget(target);
    if (!resolved) return { status: 'rejected', reason: 'no-visible-support' };
    this.finishAction('interrupted', 'placed');
    this.anchorTo(resolved.surface, resolved.u);
    this.setAction('idle');
    this.entering = false;
    this.ignoredId = null;
    this.pauses.delete('offscreen');
    this.pauses.delete('verification');
    this.pauses.delete('boundary-wait');
    this.clock.reset();
    this.schedule();
    this.flushEvents();
    return { status: 'placed' };
  }

  requestAction(action: ActionId, options: ActionOptions = {}): Promise<ActionResult> {
    if (!ACTIONS.includes(action)) return Promise.resolve({ status: 'rejected', reason: 'unsupported-action' });
    if (!this.body || !this.doc || !this.store || this.status !== 'running' || this.pauses.size) return Promise.resolve({ status: 'rejected', reason: 'not-running' });
    if (this.reduced && action !== 'idle') return Promise.resolve({ status: 'rejected', reason: 'reduced-motion' });
    if (!this.support) return Promise.resolve({ status: 'rejected', reason: 'no-support' });
    const current = this.store.refresh(this.support.surfaceId, readViewport(this.doc));
    if (!current || current.status !== 'valid' || current.sourceRevision !== this.support.sourceRevision) return Promise.resolve({ status: 'rejected', reason: 'support-invalid' });
    this.body.position = this.pointOn(current, this.support.u);
    this.saveLocalPosition();
    let velocity: Point | null = null;
    let targetId: string | null = null;
    if (action === 'jump') {
      let destination = { ...this.body.position };
      if (options.target) {
        const target = this.resolveTarget(options.target);
        if (!target) return Promise.resolve({ status: 'rejected', reason: 'target-invalid' });
        destination = this.pointOn(target.surface, target.u);
        targetId = target.surface.id;
      }
      velocity = planJump(this.body.position, destination, this.appearance.height * 5, this.appearance.height * 7, this.appearance.height * 18);
      if (!velocity) return Promise.resolve({ status: 'rejected', reason: 'unreachable' });
    }
    this.finishAction('interrupted', 'replaced');
    this.setAction(action);
    if (action === 'idle') { this.flushEvents(); return Promise.resolve({ status: 'completed' }); }
    const promise = new Promise<ActionResult>((resolve) => { this.pendingAction = resolve; });
    if (action === 'jump' || action === 'fall') {
      if (action === 'fall') { this.ignoredId = this.support.surfaceId; this.ignoredTime = 0; }
      this.releaseSupport();
      this.targetId = targetId;
      this.body.velocity = velocity ?? { x: 0, y: 1 };
      if (velocity?.x) this.facing = velocity.x < 0 ? -1 : 1;
      this.saveLocalPosition();
    }
    this.schedule();
    this.flushEvents();
    return promise;
  }

  on<K extends keyof StickFigureEvents>(event: K, listener: (payload: StickFigureEvents[K]) => void): () => void {
    if (this.status === 'destroyed') return () => {};
    const wrapped = (payload: unknown) => listener(payload as StickFigureEvents[K]);
    const listeners = this.listeners.get(event) ?? new Set<(payload: unknown) => void>();
    listeners.add(wrapped);
    this.listeners.set(event, listeners);
    return () => { listeners.delete(wrapped); };
  }

  getSnapshot(): StickFigureSnapshot {
    const surfaces = this.options.debug ? this.store?.snapshots() ?? [] : [];
    return {
      status: this.status,
      pauses: [...this.pauses],
      action: this.action,
      position: this.body ? { ...this.body.position } : null,
      velocity: this.body ? { ...this.body.velocity } : { x: 0, y: 0 },
      support: this.support ? { ...this.support } : null,
      surfaces: surfaces.map((surface) => ({ ...surface, a: { ...surface.a }, b: { ...surface.b }, available: surface.available.map((range) => ({ ...range })) })),
      diagnostics: { ...this.metrics },
    };
  }

  private bindEvents(): void {
    const doc = this.doc!;
    const win = this.win!;
    const listen = (target: EventTarget, type: string, listener: EventListener, capture = false) => {
      target.addEventListener(type, listener, { capture, passive: true });
      this.cleanup.push(() => target.removeEventListener(type, listener, capture));
    };
    const dirty = () => { this.store?.invalidate(); this.schedule(); };
    const viewChanged = () => { this.viewChanged = true; dirty(); };
    listen(doc, 'scroll', viewChanged, true);
    listen(win, 'resize', viewChanged);
    if (win.visualViewport) {
      listen(win.visualViewport, 'scroll', viewChanged);
      listen(win.visualViewport, 'resize', viewChanged);
    }
    listen(doc, 'visibilitychange', () => {
      if (doc.hidden) { this.pauses.add('document-hidden'); this.sleep(); }
      else { this.pauses.delete('document-hidden'); this.clock.reset(); dirty(); }
    });
    for (const event of ['pointerover', 'pointerout', 'focusin', 'focusout', 'transitionend', 'animationend', 'toggle', 'fullscreenchange']) listen(doc, event, dirty, true);
    const observer = new MutationObserver((records) => {
      if (records.some((record) => !(record.target.nodeType === 1 && (record.target as Element).hasAttribute('data-mono-stickfigure')))) dirty();
    });
    observer.observe(this.root!, { subtree: true, attributes: true, childList: true, characterData: true });
    this.cleanup.push(() => observer.disconnect());
    const resize = new ResizeObserver(dirty);
    resize.observe(this.root!.nodeType === 1 ? this.root as Element : doc.documentElement);
    this.cleanup.push(() => resize.disconnect());
    const media = win.matchMedia('(prefers-reduced-motion: reduce)');
    const updateMotion = () => {
      this.reduced = this.options.motionPreference !== 'full' && media.matches;
      if (this.reduced && this.support) { this.finishAction('interrupted', 'reduced-motion'); this.setAction('idle'); }
      dirty();
    };
    updateMotion();
    listen(media, 'change', updateMotion);
  }

  private schedule(): void {
    if (!this.win || this.status === 'destroyed' || this.pauses.has('user') || this.pauses.has('document-hidden') || this.raf !== null) return;
    if (this.timer !== null) { this.win.clearTimeout(this.timer); this.timer = null; }
    this.raf = this.win.requestAnimationFrame((timestamp) => {
      this.raf = null;
      try { this.tick(timestamp); }
      catch (error) {
        this.pauses.add('user');
        this.emit('error', { code: 'RUNTIME_ERROR', message: error instanceof Error ? error.message : String(error) });
        this.startReject?.(error instanceof Error ? error : new Error(String(error)));
        this.startReject = null;
        this.startResolve = null;
        this.sleep();
        this.flushEvents();
      }
    });
  }

  private tick(timestamp: number): void {
    if (!this.doc || !this.store || !this.renderer || this.status === 'destroyed') return;
    if (this.pauses.has('user') || this.pauses.has('document-hidden')) { this.sleep(); return; }
    const started = performance.now();
    const viewport = readViewport(this.doc);
    const passiveChange = this.viewChanged;
    this.viewChanged = false;
    this.store.measuredElements = 0;
    const modal = this.doc.querySelector('dialog:modal');
    if (modal || (this.doc.fullscreenElement && !this.doc.fullscreenElement.contains(this.renderer.element))) {
      this.pauses.add('top-layer');
      this.finishStart('paused');
      this.sleep();
      return;
    }
    this.pauses.delete('top-layer');
    this.store.pinned.clear();
    if (this.support) this.store.pinned.add(this.support.surfaceId);
    if (this.targetId) this.store.pinned.add(this.targetId);
    if (this.support) {
      const surface = this.store.refresh(this.support.surfaceId, viewport);
      if (!surface || surface.status === 'invalid' || surface.sourceRevision !== this.support.sourceRevision || (surface.status === 'offscreen' && this.store.clippedByAncestor(surface.id) && !passiveChange && !this.pauses.has('offscreen'))) {
        this.releaseSupport();
        this.pauses.delete('offscreen');
        this.pauses.delete('verification');
        this.setAction('fall');
        if (this.reduced) this.body = null;
      } else if (surface.status === 'unknown') {
        if (++this.unknownFrames >= 2) { this.pauses.add('verification'); this.sleep(); return; }
      } else {
        this.unknownFrames = 0;
        this.pauses.delete('verification');
        this.body!.position = this.pointOn(surface, this.support.u);
        this.saveLocalPosition();
        if (surface.status === 'offscreen') { this.pauses.add('offscreen'); this.sleep(); return; }
        this.pauses.delete('offscreen');
        if (!this.fits(surface, this.support.u)) { this.releaseSupport(); this.setAction('fall'); }
      }
    }
    if (this.body && !this.support && this.motionFrame && this.localPosition) {
      let transform = readFrame(this.motionFrame);
      if (!transform) {
        this.motionFrame = { kind: 'document', document: this.doc };
        transform = readFrame(this.motionFrame)!;
        this.localPosition = fromClient(this.body.position, transform);
      }
      this.body.position = toClient(this.localPosition, transform);
      if (!this.entering && (passiveChange || this.pauses.has('offscreen')) && !this.isInView(this.body.position, viewport)) {
        this.pauses.add('offscreen'); this.sleep(); return;
      }
      this.pauses.delete('offscreen');
    }
    if (this.pauses.has('boundary-wait')) { this.sleep(); return; }
    const scanStart = performance.now();
    this.store.scan(viewport, this.budget);
    this.metrics.scanMs = performance.now() - scanStart;
    if (this.body) this.store.refreshNearby(this.body.position, this.appearance.height * 8, viewport);
    if (!this.body) {
      const candidates = this.store.snapshots().filter((surface) => surface.status === 'valid' && surface.a.y - this.appearance.height > viewport.top && this.fits(surface, 0.5));
      const selected = candidates[Math.floor(this.random() * candidates.length)];
      if (selected) this.anchorTo(selected, 0.5);
      else if (this.startResolve && performance.now() - this.startedAt < 250) { this.schedule(); return; }
      else if (this.reduced) { this.pauses.add('verification'); this.finishStart('empty'); this.sleep(); return; }
      else this.spawn(viewport);
    }
    this.pauses.delete('verification');
    if (this.targetId) {
      const target = this.store.refresh(this.targetId, viewport);
      if (!target || target.status !== 'valid') this.finishAction('interrupted', 'target-invalid');
    }
    const surfaces = this.store.snapshots().filter((surface) => surface.id !== this.ignoredId);
    this.clock.advance(timestamp, (dt) => {
      this.actionTime += dt;
      if (this.support) {
        if (this.action === 'land-soft' && this.actionTime >= 0.3) { this.setAction('idle'); this.finishAction('completed'); }
        return;
      }
      const result = stepBody(this.body!, surfaces, dt, this.appearance.height * 18, this.appearance.height * 12, this.appearance.height * 0.13);
      this.body = result.body;
      if (this.ignoredId && (this.ignoredTime += dt) > 0.5) this.ignoredId = null;
      if (result.landing) {
        const surface = this.store!.get(result.landing.surfaceId)!;
        this.anchorTo(surface, result.landing.u);
        this.entering = false;
        this.setAction('land-soft');
      } else if (this.body.velocity.y >= 0 && this.action !== 'fall') this.setAction('fall');
      if (this.entering) {
        this.enteringTime += dt;
        if (this.isInView(this.body.position, viewport)) this.entering = false;
        else if (this.enteringTime > 2) this.pauses.add('boundary-wait');
      }
      this.handleBoundary(viewport);
    });
    this.saveLocalPosition();
    const dt = this.previousRender === null ? 1 / 60 : Math.min(0.05, (timestamp - this.previousRender) / 1000);
    this.previousRender = timestamp;
    samplePose(this.pose, { height: this.appearance.height, action: this.action, time: this.actionTime, dt, verticalVelocity: this.body!.velocity.y, landProgress: this.actionTime / 0.3, facing: this.facing });
    this.renderer.draw(this.body!.position, this.pose);
    this.renderer.setVisible(!this.pauses.size);
    this.setStatus(this.pauses.size ? 'paused' : 'running');
    this.finishStart(this.support ? 'ready' : 'empty');
    this.metrics = {
      frameMs: performance.now() - started - this.metrics.scanMs,
      scanMs: this.metrics.scanMs,
      measuredElements: this.store.measuredElements,
      surfaceCount: surfaces.length,
      droppedTimeMs: this.clock.droppedTimeMs,
    };
    this.flushEvents();
    if (this.pauses.size) this.sleep();
    else this.schedule();
  }

  private handleBoundary(viewport: Viewport): void {
    if (!this.body || this.support || this.entering) return;
    const p = this.body.position;
    const h = this.appearance.height;
    let axis: 'x' | 'y' | null = null;
    if (p.x - h / 2 > viewport.right || p.x + h / 2 < viewport.left) {
      if (this.options.boundary?.wrapX === false) { this.pauses.add('boundary-wait'); return; }
      p.x = p.x > viewport.right ? viewport.left - h / 3 : viewport.right + h / 3;
      axis = 'x';
    } else if (p.y - h > viewport.bottom) {
      if (this.options.boundary?.wrapY === false) { this.pauses.add('boundary-wait'); return; }
      p.y = viewport.top - h / 3;
      axis = 'y';
    }
    if (axis) {
      this.entering = true;
      this.enteringTime = 0;
      this.ignoredId = null;
      this.finishAction('interrupted', 'boundary');
      this.setAction('fall');
      this.emit('boundary', { axis });
    }
  }

  private resolveTarget(target: PlaceTarget): { surface: SurfaceSnapshot; u: number } | null {
    if (!this.doc || !this.store || !this.root) return null;
    let surface: SurfaceSnapshot | null;
    let u = 0.5;
    if ('nodeType' in target) {
      if (target.ownerDocument !== this.doc || !this.root.contains(target)) return null;
      surface = this.store.measure(target, readViewport(this.doc));
    } else {
      surface = this.store.refresh(target.surfaceId, readViewport(this.doc));
      u = target.u ?? 0.5;
    }
    if (!surface || surface.status !== 'valid' || !Number.isFinite(u) || !this.fits(surface, u)) return null;
    const point = this.pointOn(surface, u);
    if (point.y - this.appearance.height < readViewport(this.doc).top) return null;
    return { surface, u };
  }

  private fits(surface: SurfaceSnapshot, u: number): boolean {
    const length = surface.b.x - surface.a.x;
    const margin = this.appearance.height * 0.13 / length;
    return length > 0 && surface.available.some((interval) => u - margin >= interval.start && u + margin <= interval.end);
  }

  private pointOn(surface: SurfaceSnapshot, u: number): Point {
    return { x: surface.a.x + (surface.b.x - surface.a.x) * u, y: surface.a.y + (surface.b.y - surface.a.y) * u };
  }

  private anchorTo(surface: SurfaceSnapshot, u: number): void {
    this.support = { surfaceId: surface.id, sourceRevision: surface.sourceRevision, u };
    this.body = { position: this.pointOn(surface, u), velocity: { x: 0, y: 0 } };
    const element = this.store!.element(surface.id)!;
    this.motionFrame = selectFrame(element);
    this.saveLocalPosition();
    this.emit('surfacechange', { support: { ...this.support } });
  }

  private releaseSupport(): void {
    if (this.support) this.emit('surfacechange', { support: null });
    this.support = null;
    this.unknownFrames = 0;
    this.saveLocalPosition();
  }

  private saveLocalPosition(): void {
    if (!this.body || !this.motionFrame) return;
    const transform = readFrame(this.motionFrame);
    if (transform) this.localPosition = fromClient(this.body.position, transform);
  }

  private spawn(viewport: Viewport): void {
    this.motionFrame = { kind: 'document', document: this.doc! };
    this.body = { position: { x: (viewport.left + viewport.right) / 2, y: viewport.top - this.appearance.height / 3 }, velocity: { x: 0, y: 0 } };
    this.support = null;
    this.entering = true;
    this.enteringTime = 0;
    this.setAction('fall');
    this.saveLocalPosition();
  }

  private isInView(point: Point, viewport: Viewport): boolean {
    return point.x >= viewport.left && point.x <= viewport.right && point.y >= viewport.top && point.y - this.appearance.height <= viewport.bottom;
  }

  private sleep(): void {
    if (!this.win || this.status === 'destroyed') return;
    if (this.raf !== null) { this.win.cancelAnimationFrame(this.raf); this.raf = null; }
    if (this.timer !== null) this.win.clearTimeout(this.timer);
    this.timer = null;
    this.clock.reset();
    this.previousRender = null;
    this.renderer?.setVisible(false);
    this.setStatus('paused');
    if (!this.pauses.has('user') && !this.pauses.has('document-hidden')) {
      this.timer = this.win.setTimeout(() => { this.timer = null; this.schedule(); }, 250);
    }
    this.flushEvents();
  }

  private finishStart(status: StartResult['status']): void {
    if (!this.startResolve) return;
    const result: StartResult = { status, supportedActions: [...ACTIONS] };
    this.startResolve(result);
    this.startResolve = null;
    this.startReject = null;
    this.emit('ready', result);
  }

  private finishAction(status: ActionResult['status'], reason?: string): void {
    this.pendingAction?.({ status, ...(reason ? { reason } : {}) });
    this.pendingAction = null;
    this.targetId = null;
  }

  private setAction(action: ActionId): void {
    if (action !== this.action) this.emit('actionchange', { action });
    this.action = action;
    this.actionTime = 0;
  }

  private setStatus(status: LifecycleStatus): void {
    if (status === this.status) return;
    this.status = status;
    this.emit('statechange', status);
  }

  private emit<K extends keyof StickFigureEvents>(type: K, payload: StickFigureEvents[K]): void {
    this.events.push({ type, payload });
  }

  private flushEvents(): void {
    const events = this.events;
    this.events = [];
    for (const event of events) {
      for (const listener of this.listeners.get(event.type) ?? []) {
        if (this.status === 'destroyed' && !(event.type === 'statechange' && event.payload === 'destroyed')) return;
        try { listener(event.payload); }
        catch (error) {
          if (event.type !== 'error') {
            const message = error instanceof Error ? error.message : String(error);
            this.emit('error', { code: 'LISTENER_ERROR', message });
          }
        }
      }
    }
  }

  private releaseResources(): void {
    if (this.raf !== null) this.win?.cancelAnimationFrame(this.raf);
    if (this.timer !== null) this.win?.clearTimeout(this.timer);
    this.raf = null;
    this.timer = null;
    for (const dispose of this.cleanup.splice(0)) dispose();
    this.renderer?.destroy();
    this.renderer = null;
    this.store?.clear();
    this.store = null;
    this.root = null;
    this.win = null;
    this.doc = null;
    this.clock.reset();
  }

  private random(): number {
    this.seed += 0x6d2b79f5;
    let value = this.seed;
    value = Math.imul(value ^ value >>> 15, value | 1);
    value ^= value + Math.imul(value ^ value >>> 7, value | 61);
    return ((value ^ value >>> 14) >>> 0) / 4294967296;
  }
}
