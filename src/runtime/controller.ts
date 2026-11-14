import { createPose, samplePose, LAND_DURATION, ROLL_DURATION, POSE_DURATION, STAND_DURATION, TURN_DURATION, TRANSITION_DURATION } from '../animation/rig';
import { fromClient, isViewportMount, readFrame, readViewport, selectFrame, toClient } from '../coordinates/frames';
import type { FrameTransform, MotionFrame } from '../coordinates/frames';
import { stepBody, stepWalk } from '../motion/solver';
import { findRoute, firstLanding, planTakeoff, reachableRoutes } from '../motion/navigation';
import type { NavigationPhysics, NavigationStep, NavigationTarget, TakeoffPlan } from '../motion/navigation';
import { CanvasRenderer } from '../rendering/canvas';
import { SurfaceStore } from '../scene/store';
import type { Anchor, Body, Point, SurfaceSnapshot, Viewport } from '../scene/types';
import type { ActionId, ActionOptions, ActionResult, Appearance, Diagnostics, LifecycleStatus, MoveOptions, MoveTarget, PauseReason, Physics, Recognition, PlaceResult, PlaceTarget, StartResult, StickFigure, StickFigureEvents, StickFigureOptions, StickFigureSnapshot } from '../types';
import { FixedStepClock } from './scheduler';

const ACTIONS: readonly ActionId[] = ['idle', 'walk', 'run', 'sprint', 'turn', 'wave', 'crouch', 'rest', 'prone', 'stand-up', 'jump', 'run-jump', 'running-long-jump', 'fall', 'land-soft', 'roll'];
type JumpTarget = NavigationTarget & { sourceRevision: number };
type MovingAction = 'walk' | 'run' | 'sprint';
type PendingEvent = { type: keyof StickFigureEvents; payload: StickFigureEvents[keyof StickFigureEvents] };

interface PhysicsSample {
  position: Point;
  velocity: Point;
  support: Anchor | null;
  frame: MotionFrame | null;
  action: ActionId;
  actionTime: number;
  time: number;
  distance: number;
}

function positive(value: number, name: string): number {
  if (!Number.isFinite(value) || value <= 0) throw new RangeError(`${name} 必须是有限正数`);
  return value;
}

export class StickFigureController implements StickFigure {
  private options: StickFigureOptions;
  private readonly appearance: Appearance;
  private readonly physics: Physics;
  private readonly recognition: Recognition;
  private autonomous: boolean;
  private simulationTime = 0;
  private decisionAt = 0;
  private decisions = 0;
  private walkDuration = 0;
  private goal: (NavigationTarget & { sourceRevision: number; automatic: boolean }) | null = null;
  private route: NavigationStep[] = [];
  private pace: MovingAction = 'walk';
  private goalChangeAt = 0;
  private pendingMove: ((result: ActionResult) => void) | null = null;
  private moveAbort: (() => void) | null = null;
  private actionAbort: (() => void) | null = null;
  private afterTransition: (() => void) | null = null;
  private pendingJump: { target: JumpTarget | null; long: boolean } | null = null;
  private actionTarget: JumpTarget | null = null;
  private dash: { target: JumpTarget | null; long: boolean; phase: 'position' | 'run'; direction: 1 | -1; startU: number; launchU: number; speed: number } | null = null;
  private resumeMotion: { action: MovingAction; duration: number } | null = null;
  private landingRoll = false;
  private landStrength = 0;
  private rollSpeed = 0;
  private rollDuration = ROLL_DURATION;
  private poseDuration = 0;
  private readonly visits = new Map<string, number>();
  private localGoals = 0;
  private explorationTarget: Point | null = null;
  private gaitDistance = 0;
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
  private targetRevision: number | null = null;
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
  private previousPhysics: PhysicsSample | null = null;
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
    this.appearance = { height: 18, color: '#181818', lineWidth: 1.2, head: 'circle', ...options.appearance };
    this.physics = { gravity: 980, jumpHeight: 52, ...options.physics };
    this.recognition = { colorTolerance: 0.01, ...options.recognition };
    positive(this.recognition.colorTolerance, 'recognition.colorTolerance');
    if (this.recognition.colorTolerance > 1) throw new RangeError('colorTolerance 应不超过 1');
    positive(this.physics.gravity, 'physics.gravity');
    positive(this.physics.jumpHeight, 'physics.jumpHeight');
    if (typeof (options.autonomous ?? true) !== 'boolean') throw new TypeError('autonomous 必须是布尔值');
    this.autonomous = options.autonomous ?? true;
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
      this.store = new SurfaceStore(root, this.limit, this.recognition.colorTolerance);
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
    this.previousPhysics = null;
    this.schedule();
  }

  setAutonomous(enabled: boolean): void {
    if (typeof enabled !== 'boolean') throw new TypeError('autonomous 必须是布尔值');
    if (this.status === 'destroyed') return;
    this.autonomous = enabled;
    this.decisionAt = this.simulationTime + 0.3;
    if (!enabled && this.goal?.automatic) this.finishMove('interrupted', 'autonomy-disabled');
    if (!enabled && !this.pendingAction) {
      this.dash = null;
      this.resumeMotion = null;
      if (this.action === 'walk' || this.action === 'run' || this.action === 'sprint') this.walkDuration = this.actionTime;
      if (this.support && (this.action === 'anticipate' || this.action === 'turn')) { this.pendingJump = null; this.afterTransition = null; this.stopThen(() => this.setAction('idle')); }
    }
    this.schedule();
  }

  destroy(): void {
    if (this.status === 'destroyed') return;
    this.finishAction('interrupted', 'destroyed');
    this.finishMove('interrupted', 'destroyed');
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
    this.finishMove('interrupted', 'placed');
    this.anchorTo(resolved.surface, resolved.u);
    this.setAction('idle');
    this.gaitDistance = 0;
    this.pose.phase = 0;
    this.pose.distance = 0;
    this.pose.walking = 0;
    this.decisions = 0;
    this.visits.clear();
    this.visits.set(resolved.surface.id, 1);
    this.localGoals = 0;
    this.decisionAt = this.simulationTime + 0.8;
    this.entering = false;
    this.ignoredId = null;
    this.pauses.delete('offscreen');
    this.pauses.delete('verification');
    this.pauses.delete('boundary-wait');
    this.clock.reset();
    this.previousPhysics = null;
    this.schedule();
    this.flushEvents();
    return { status: 'placed' };
  }

  moveTo(target: MoveTarget, options: MoveOptions = {}): Promise<ActionResult> {
    if (!this.body || !this.store || !this.doc || this.status !== 'running' || this.pauses.size) return Promise.resolve({ status: 'rejected', reason: 'not-running' });
    if (this.reduced) return Promise.resolve({ status: 'rejected', reason: 'reduced-motion' });
    const pace = options.pace ?? 'walk';
    if (!['walk', 'run', 'sprint'].includes(pace)) return Promise.resolve({ status: 'rejected', reason: 'unsupported-pace' });
    if (options.signal?.aborted) return Promise.resolve({ status: 'interrupted', reason: 'aborted' });
    const resolved = this.resolveMoveTarget(target);
    if (!resolved) return Promise.resolve({ status: 'rejected', reason: 'no-visible-support' });
    const goal = { surfaceId: resolved.surface.id, u: resolved.u, sourceRevision: resolved.surface.sourceRevision, automatic: false };
    const route = this.support ? findRoute(this.store.snapshots(), this.support, goal, this.navigationPhysics(pace)) : [];
    if (!route) return Promise.resolve({ status: 'rejected', reason: 'unreachable' });
    this.finishAction('interrupted', 'move-requested');
    this.finishMove('interrupted', 'replaced');
    const promise = new Promise<ActionResult>((resolve) => { this.pendingMove = resolve; });
    this.bindAbort(options.signal, 'move');
    this.goal = goal;
    this.route = route;
    this.pace = pace;
    this.emit('targetchange', { target: this.pointOn(resolved.surface, resolved.u) });
    if (this.support) this.readyThen(() => this.beginRouteStep());
    this.schedule();
    this.flushEvents();
    return promise;
  }

  requestAction(action: ActionId, options: ActionOptions = {}): Promise<ActionResult> {
    if (!ACTIONS.includes(action)) return Promise.resolve({ status: 'rejected', reason: 'unsupported-action' });
    if (options.direction !== undefined && options.direction !== 1 && options.direction !== -1) return Promise.resolve({ status: 'rejected', reason: 'invalid-direction' });
    if (options.duration !== undefined && (!Number.isFinite(options.duration) || options.duration < 0.1 || options.duration > 10)) return Promise.resolve({ status: 'rejected', reason: 'invalid-duration' });
    if (options.signal?.aborted) return Promise.resolve({ status: 'interrupted', reason: 'aborted' });
    if ((action === 'walk' || action === 'run' || action === 'sprint') && options.target) return this.moveTo(options.target, { pace: action, ...(options.signal ? { signal: options.signal } : {}) });
    if (!this.body || !this.doc || !this.store || this.status !== 'running' || this.pauses.size) return Promise.resolve({ status: 'rejected', reason: 'not-running' });
    if (this.reduced && action !== 'idle') return Promise.resolve({ status: 'rejected', reason: 'reduced-motion' });
    if (!this.support) return Promise.resolve({ status: 'rejected', reason: 'no-support' });
    const current = this.store.refresh(this.support.surfaceId, readViewport(this.doc));
    if (!current || current.status !== 'valid' || current.sourceRevision !== this.support.sourceRevision || !this.fits(current, this.support.u)) return Promise.resolve({ status: 'rejected', reason: 'support-invalid' });
    this.body.position = this.pointOn(current, this.support.u);
    this.saveLocalPosition();
    const jumping = action === 'jump' || action === 'run-jump' || action === 'running-long-jump';
    const long = action === 'running-long-jump';
    const moving = this.action === 'walk' || this.action === 'run' || this.action === 'sprint' ? this.action : null;
    const direction = options.direction ?? this.facing;
    const rollDuration = options.duration ?? ROLL_DURATION;
    if (action === 'roll' && rollDuration < 0.65) return Promise.resolve({ status: 'rejected', reason: 'invalid-duration' });
    if (action === 'prone' && !this.fitsProne(current, this.support.u, direction)) return Promise.resolve({ status: 'rejected', reason: 'insufficient-space' });
    if (action === 'roll' && !this.fitsRoll(current, this.support.u, direction, rollDuration)) return Promise.resolve({ status: 'rejected', reason: 'insufficient-space' });
    let jumpTarget: JumpTarget | null = null;
    let takeoff: TakeoffPlan | null = null;
    if (jumping && options.target) {
      const resolved = this.resolveMoveTarget(options.target);
      if (!resolved) return Promise.resolve({ status: 'rejected', reason: 'target-invalid' });
      takeoff = planTakeoff(current, this.support.u, this.pointOn(resolved.surface, resolved.u), this.navigationPhysics(), long, this.store.snapshots(), resolved.surface.id);
      if (!takeoff) return Promise.resolve({ status: 'rejected', reason: 'unreachable' });
      jumpTarget = { surfaceId: resolved.surface.id, u: resolved.u, sourceRevision: resolved.surface.sourceRevision };
    }
    const remaining = moving ? Math.max(0.8, this.walkDuration - this.actionTime) : 1.5;
    const keepMove = (jumping && !long && !options.target || action === 'roll') && Boolean(moving && this.goal);
    this.finishAction('interrupted', 'replaced');
    if (!keepMove) this.finishMove('interrupted', 'action-requested');
    else this.route = [];
    this.decisionAt = this.simulationTime + 3;
    const promise = new Promise<ActionResult>((resolve) => { this.pendingAction = resolve; });
    this.bindAbort(options.signal, 'action');
    if (action === 'idle') {
      this.readyThen(() => { this.setAction('idle'); this.finishAction('completed'); });
    } else if (action === 'walk' || action === 'run' || action === 'sprint') {
      const start = () => { this.walkDuration = options.duration ?? (action === 'walk' ? 2.4 : 1.5); this.setAction(action); };
      this.readyThen(() => direction !== this.facing ? this.beginTurn(direction, start) : start());
    } else if (action === 'turn') {
      this.readyThen(() => this.beginTurn(options.direction ?? (this.facing === 1 ? -1 : 1), () => { this.setAction('idle'); this.finishAction('completed'); }));
    } else if (action === 'wave' || action === 'crouch' || action === 'rest' || action === 'prone') {
      this.readyThen(() => {
        const start = () => { this.poseDuration = options.duration ?? POSE_DURATION[action]; this.setAction(action); };
        if (direction !== this.facing) this.beginTurn(direction, start);
        else start();
      });
    } else if (jumping) {
      if (moving || action !== 'jump') this.resumeMotion = { action: moving ?? 'run', duration: Number.isFinite(remaining) ? remaining : 1.5 };
      this.actionTarget = jumpTarget;
      this.targetId = jumpTarget?.surfaceId ?? null;
      this.targetRevision = jumpTarget?.sourceRevision ?? null;
      if (jumpTarget) this.emit('targetchange', { target: this.pointOn(this.store.get(jumpTarget.surfaceId)!, jumpTarget.u) });
      const reversing = direction !== this.facing || (Math.abs(this.body.velocity.x) > 0.5 && Math.sign(this.body.velocity.x) !== direction);
      if (takeoff) this.readyThen(() => this.beginDash(jumpTarget, long, direction, takeoff!));
      else if (long || (action === 'run-jump' && (Math.abs(this.body.velocity.x) < this.appearance.height || reversing))) this.readyThen(() => this.beginDash(jumpTarget, long, direction));
      else {
        const prepare = () => this.queueJump(jumpTarget);
        if (reversing) this.readyThen(() => this.beginTurn(direction, prepare));
        else this.standThen(prepare);
      }
    } else if (action === 'roll') {
      this.rollDuration = rollDuration;
      if (moving) this.resumeMotion = { action: moving, duration: Number.isFinite(remaining) ? remaining : 1.5 };
      this.readyThen(() => {
        const start = () => { this.rollSpeed = this.appearance.height * 2.4; this.setAction('roll'); };
        if (direction !== this.facing) this.beginTurn(direction, start);
        else start();
      });
    } else if (action === 'fall') {
      this.dropSupport();
    } else if (action === 'stand-up') {
      this.readyThen(() => { this.setAction('idle'); this.finishAction('completed'); });
    } else {
      this.setAction(action);
    }
    this.schedule();
    this.flushEvents();
    return promise;
  }

  private readyThen(next: () => void): void {
    this.stopThen(() => this.standThen(next));
  }

  private standThen(next: () => void): void {
    if (this.action === 'crouch' || this.action === 'prone' || this.action === 'roll' || this.pose.crouch > 0.1 || this.pose.prone > 0.1 || this.pose.roll > 0.1 || Math.abs(Math.sin(this.pose.rollAngle / 2)) > 0.1) {
      this.afterTransition = next;
      this.setAction('stand-up');
    } else next();
  }

  private stopThen(next: () => void): void {
    if (Math.abs(this.body!.velocity.x) < 0.5) { this.body!.velocity.x = 0; next(); }
    else { this.afterTransition = next; this.setAction('brake'); }
  }

  private beginTurn(direction: 1 | -1, next: () => void): void {
    if (direction === this.facing) { next(); return; }
    this.facing = direction;
    this.afterTransition = next;
    this.setAction('turn');
  }

  private queueJump(target: JumpTarget | null, long = false): void {
    this.dash = null;
    this.targetId = target?.surfaceId ?? null;
    this.targetRevision = target?.sourceRevision ?? null;
    let direction: 1 | -1 = this.facing;
    if (target) {
      const surface = this.store!.get(target.surfaceId);
      if (!surface) { this.finishAction('interrupted', 'target-invalid'); this.finishMove('interrupted', 'target-invalid'); return; }
      const dx = this.pointOn(surface, target.u).x - this.body!.position.x;
      direction = Math.abs(dx) < 1 ? this.facing : dx < 0 ? -1 : 1;
    }
    const prepare = () => {
      this.pendingJump = { target, long };
      this.setAction('anticipate');
    };
    if (direction !== this.facing) this.readyThen(() => this.beginTurn(direction, prepare));
    else this.standThen(prepare);
  }

  private jumpSpeed(long = false): number {
    return Math.sqrt(2 * this.physics.gravity * this.physics.jumpHeight * (long ? 1.65 : 1));
  }

  private beginDash(target: JumpTarget | null, long: boolean, direction: 1 | -1, plan?: TakeoffPlan): void {
    if (!this.support || !this.body) return;
    const surface = this.store!.get(this.support.surfaceId)!;
    const width = surface.b.x - surface.a.x;
    const h = this.appearance.height;
    const margin = h * 0.26 / width;
    const interval = surface.available.find((range) => this.support!.u >= range.start && this.support!.u <= range.end)!;
    const left = interval.start + margin, right = interval.end - margin;
    if (target) {
      const destination = this.store!.get(target.surfaceId);
      if (!destination) { this.finishAction('interrupted', 'target-invalid'); return; }
      direction = this.pointOn(destination, target.u).x < this.body.position.x ? -1 : 1;
    }
    let speed = plan ? Math.abs(plan.velocity.x) : h * (long ? 8 : 4.6);
    if (plan && speed > 0.5) direction = plan.velocity.x < 0 ? -1 : 1;
    const distance = speed ** 2 / (2 * h * 18) + speed * TRANSITION_DURATION.anticipate + h * 0.3;
    const span = Math.min(right - left, distance / width);
    const forward = Math.max(0, direction === 1 ? right - this.support.u : this.support.u - left);
    const launchU = plan?.launchU ?? this.support.u + direction * Math.min(span, forward);
    const startU = plan?.startU ?? launchU - direction * span;
    if (!plan) {
      const available = Math.abs(launchU - startU) * width;
      const acceleration = h * 18, prepare = TRANSITION_DURATION.anticipate;
      speed = Math.min(speed, Math.sqrt((acceleration * prepare) ** 2 + 2 * acceleration * available) - acceleration * prepare);
    }
    this.dash = { target, long, phase: 'position', direction, startU, launchU, speed };
    this.targetId = target?.surfaceId ?? null;
    this.targetRevision = target?.sourceRevision ?? null;
    const dx = this.pointOn(surface, startU).x - this.body.position.x;
    if (Math.abs(dx) < 0.5) this.startDashRun();
    else this.beginTurn(dx < 0 ? -1 : 1, () => { this.walkDuration = Infinity; this.setAction('run'); });
  }

  private startDashRun(): void {
    const dash = this.dash!;
    if (dash.speed < 0.5) { this.queueJump(dash.target, dash.long); return; }
    dash.phase = 'run';
    this.beginTurn(dash.direction, () => { this.walkDuration = Infinity; this.setAction(dash.long ? 'sprint' : 'run'); });
  }

  private launchJump(): void {
    const jump = this.pendingJump;
    if (!jump || !this.support || !this.body) return;
    const velocity = { x: this.body.velocity.x, y: -this.jumpSpeed(jump.long) };
    if (Math.abs(velocity.x) > 0.5 && Math.sign(velocity.x) !== this.facing) {
      this.readyThen(() => this.queueJump(jump.target, jump.long));
      return;
    }
    if (jump.target) {
      const surface = this.store!.refresh(jump.target.surfaceId, readViewport(this.doc!));
      if (!surface || surface.status !== 'valid' || surface.sourceRevision !== jump.target.sourceRevision) {
        this.finishAction('interrupted', 'target-invalid'); this.finishMove('interrupted', 'target-invalid'); this.setAction('idle'); return;
      }
      const landing = firstLanding(this.body.position, velocity, this.store!.snapshots(), this.physics.gravity, this.appearance.height * 0.26, undefined, this.appearance.height);
      const error = landing ? Math.abs(landing.u - jump.target.u) * (surface.b.x - surface.a.x) : Infinity;
      if (landing?.surfaceId !== surface.id || error > this.appearance.height * 0.4) {
        this.finishAction('interrupted', 'path-changed'); this.finishMove('interrupted', 'path-changed'); this.stopThen(() => this.setAction('idle')); return;
      }
    }
    if (jump.long && !jump.target) {
      const time = this.jumpSpeed(true) * 2 / this.physics.gravity;
      const point = { x: this.body.position.x + velocity.x * time, y: this.body.position.y };
      const transform = this.motionFrame && readFrame(this.motionFrame);
      if (transform) this.explorationTarget = fromClient(point, transform);
      this.emit('targetchange', { target: point });
    }
    this.pendingJump = null;
    this.releaseSupport();
    this.body.velocity = velocity;
    this.setAction(jump.long ? 'running-long-jump' : this.resumeMotion && this.resumeMotion.action !== 'walk' ? 'run-jump' : 'jump');
    this.saveLocalPosition();
  }

  private dropSupport(): void {
    this.ignoredId = this.support!.surfaceId;
    this.ignoredTime = 0;
    this.releaseSupport();
    this.body!.velocity.y = 0;
    this.setAction('fall');
    this.saveLocalPosition();
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
    const selectedTarget = this.goal ?? this.actionTarget;
    const targetSurface = selectedTarget ? this.store?.get(selectedTarget.surfaceId) : null;
    const explorationFrame = this.explorationTarget && this.motionFrame ? readFrame(this.motionFrame) : null;
    const path: Point[] = [];
    for (const step of this.route) {
      const surface = this.store?.get(step.surfaceId);
      if (surface) path.push(this.pointOn(surface, step.u));
    }
    return {
      status: this.status,
      pauses: [...this.pauses],
      action: this.action,
      facing: this.facing,
      autonomous: this.autonomous,
      appearance: { ...this.appearance },
      physics: { ...this.physics },
      recognition: { ...this.recognition },
      position: this.body ? { ...this.body.position } : null,
      velocity: this.body ? { ...this.body.velocity } : { x: 0, y: 0 },
      support: this.support ? { ...this.support } : null,
      target: selectedTarget && targetSurface ? { surfaceId: selectedTarget.surfaceId, u: selectedTarget.u, position: this.pointOn(targetSurface, selectedTarget.u) } : this.explorationTarget && explorationFrame ? { position: toClient(this.explorationTarget, explorationFrame) } : null,
      path,
      surfaces: surfaces.map((surface) => ({ ...surface, a: { ...surface.a }, b: { ...surface.b }, available: surface.available.map((range) => ({ ...range })), ...(surface.bounds ? { bounds: { ...surface.bounds } } : {}) })),
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
      else { this.pauses.delete('document-hidden'); this.clock.reset(); this.previousPhysics = null; dirty(); }
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
    listen(doc.fonts, 'loadingdone', () => { this.store?.invalidateFonts(); this.schedule(); });
    const media = win.matchMedia('(prefers-reduced-motion: reduce)');
    const updateMotion = () => {
      this.reduced = this.options.motionPreference !== 'full' && media.matches;
      if (this.reduced && this.support) { this.finishAction('interrupted', 'reduced-motion'); this.finishMove('interrupted', 'reduced-motion'); this.body!.velocity.x = 0; this.setAction('idle'); }
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
    this.store.beginFrame(viewport);
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
    if (this.goal) this.store.pinned.add(this.goal.surfaceId);
    if (this.support) {
      const surface = this.store.refresh(this.support.surfaceId, viewport);
      if (!surface || surface.status === 'invalid' || surface.sourceRevision !== this.support.sourceRevision || (surface.status === 'offscreen' && this.store.clippedByAncestor(surface.id) && !passiveChange && !this.pauses.has('offscreen'))) {
        this.finishAction('interrupted', 'support-invalid');
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
      const candidates = this.store.snapshots().flatMap((surface) => {
        const u = this.standingU(surface);
        return u !== null && surface.a.y - this.appearance.height > viewport.top ? [{ surface, u }] : [];
      });
      const selected = candidates[Math.floor(this.random() * candidates.length)];
      if (selected) this.anchorTo(selected.surface, selected.u);
      else if (this.startResolve && performance.now() - this.startedAt < 250) { this.schedule(); return; }
      else if (this.reduced) { this.pauses.add('verification'); this.finishStart('empty'); this.sleep(); return; }
      else this.spawn(viewport);
    }
    this.pauses.delete('verification');
    if (this.goal) {
      const goal = this.store.refresh(this.goal.surfaceId, viewport);
      if (!goal || goal.status !== 'valid' || goal.sourceRevision !== this.goal.sourceRevision || !this.fits(goal, this.goal.u)) this.finishMove('interrupted', 'target-invalid');
    }
    if (this.targetId) {
      const target = this.store.refresh(this.targetId, viewport);
      if (!target || target.status !== 'valid' || target.sourceRevision !== this.targetRevision) {
        this.finishAction('interrupted', 'target-invalid');
        if (this.goal) this.finishMove('interrupted', 'target-invalid');
        if (this.support) this.readyThen(() => this.setAction('idle'));
      }
    }
    const surfaces = this.store.snapshots().filter((surface) => surface.id !== this.ignoredId);
    let sampledFrame = this.motionFrame;
    let sampledTransform: FrameTransform | null = sampledFrame ? readFrame(sampledFrame) : null;
    const alpha = this.clock.advance(timestamp, (dt) => {
      if (sampledFrame !== this.motionFrame) {
        sampledFrame = this.motionFrame;
        sampledTransform = sampledFrame ? readFrame(sampledFrame) : null;
      }
      this.previousPhysics = {
        position: sampledTransform ? fromClient(this.body!.position, sampledTransform) : { ...this.body!.position },
        velocity: { ...this.body!.velocity },
        support: this.support ? { ...this.support } : null,
        frame: sampledTransform ? sampledFrame : null,
        action: this.action,
        actionTime: this.actionTime,
        time: this.simulationTime,
        distance: this.gaitDistance,
      };
      this.simulationTime += dt;
      this.actionTime += dt;
      if (this.support) {
        this.stepGround(dt, viewport, surfaces);
        return;
      }
      const result = stepBody(this.body!, surfaces, dt, this.physics.gravity, Number.POSITIVE_INFINITY, this.appearance.height * 0.26, this.appearance.height);
      this.body = result.body;
      if (this.ignoredId && (this.ignoredTime += dt) > 0.5) this.ignoredId = null;
      if (result.landing) {
        const surface = this.store!.get(result.landing.surfaceId)!;
        const speed = result.body.velocity.x;
        const direction: 1 | -1 = Math.abs(speed) > 0.5 ? speed < 0 ? -1 : 1 : this.facing;
        const high = result.landing.impactSpeed ** 2 / (2 * this.physics.gravity) > Math.max(this.physics.jumpHeight * 1.2, this.appearance.height * 4);
        this.landStrength = Math.min(1, result.landing.impactSpeed / (this.jumpSpeed() * 1.5));
        this.rollDuration = ROLL_DURATION;
        this.anchorTo(surface, result.landing.u);
        this.landingRoll = high && this.fitsRoll(surface, result.landing.u, direction);
        if (this.resumeMotion || this.goal || this.landingRoll) this.body.velocity.x = speed;
        if (this.landingRoll) {
          this.facing = direction;
          this.rollSpeed = Math.max(this.appearance.height * 2, Math.min(this.appearance.height * 3.2, Math.abs(speed)));
        }
        if (this.goal) {
          const step = this.route[0];
          if (step && step.kind !== 'walk' && step.surfaceId === surface.id) this.route.shift();
          else this.route = [];
        }
        this.entering = false;
        this.explorationTarget = null;
        this.setAction('land-soft');
      } else if (this.body.velocity.y >= 0 && this.action !== 'fall' && this.action !== 'run-jump' && this.action !== 'running-long-jump') this.setAction('fall');
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
    let renderPosition = this.body!.position;
    let renderDistance = this.gaitDistance;
    let renderTime = this.simulationTime;
    let renderActionTime = this.actionTime;
    let renderVelocity = this.body!.velocity;
    const previous = this.previousPhysics;
    if (previous) {
      if (this.support && previous.support && this.support.surfaceId === previous.support.surfaceId && this.support.sourceRevision === previous.support.sourceRevision) {
        const surface = this.store.get(this.support.surfaceId)!;
        renderPosition = this.pointOn(surface, previous.support.u + (this.support.u - previous.support.u) * alpha);
      } else if (!this.support && !previous.support && previous.frame && previous.frame === this.motionFrame) {
        const transform = readFrame(previous.frame);
        if (transform) {
          const origin = toClient(previous.position, transform);
          renderPosition = { x: origin.x + (this.body!.position.x - origin.x) * alpha, y: origin.y + (this.body!.position.y - origin.y) * alpha };
        }
      }
      renderDistance = previous.distance + (this.gaitDistance - previous.distance) * alpha;
      renderTime = previous.time + (this.simulationTime - previous.time) * alpha;
      renderVelocity = { x: previous.velocity.x + (this.body!.velocity.x - previous.velocity.x) * alpha, y: previous.velocity.y + (this.body!.velocity.y - previous.velocity.y) * alpha };
      if (previous.action === this.action && previous.actionTime <= this.actionTime) renderActionTime = previous.actionTime + (this.actionTime - previous.actionTime) * alpha;
    }
    samplePose(this.pose, { height: this.appearance.height, action: this.action, time: renderActionTime, clock: renderTime, dt, verticalVelocity: renderVelocity.y, landProgress: renderActionTime / LAND_DURATION, landStrength: this.landStrength, facing: this.facing, distance: renderDistance, horizontalSpeed: renderVelocity.x, turnProgress: this.action === 'turn' ? renderActionTime / TURN_DURATION : undefined, actionDuration: this.action === 'roll' ? this.rollDuration : this.poseDuration });
    this.renderer.draw(renderPosition, this.pose);
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

  private stepGround(dt: number, viewport: Viewport, surfaces: readonly SurfaceSnapshot[]): void {
    const surface = this.store!.get(this.support!.surfaceId)!;
    if (surface.status !== 'valid') return;
    const h = this.appearance.height;
    const advance = (desired: number, acceleration = h * 10) => {
      const result = stepWalk(this.body!, surface, this.support!.u, desired, acceleration, dt, h * 0.26, surfaces, h);
      this.body = result.body;
      this.support!.u = result.u;
      this.gaitDistance += result.distance;
      return result;
    };
    if (this.action === 'brake') {
      advance(0);
      if (Math.abs(this.body!.velocity.x) < 0.5 && this.actionTime >= TRANSITION_DURATION.brake) this.completeTransition();
      return;
    }
    if (this.action === 'turn' || this.action === 'stand-up') {
      if (this.actionTime >= (this.action === 'turn' ? TURN_DURATION : STAND_DURATION)) this.completeTransition();
      return;
    }
    if (this.action === 'anticipate') {
      const speed = this.body!.velocity.x;
      const result = advance(speed);
      if (result.blocked) { this.finishAction('interrupted', 'obstructed'); this.finishMove('interrupted', 'obstructed'); this.setAction('idle'); return; }
      if (result.edge && this.pendingJump) {
        this.body!.velocity.x = speed;
        this.launchJump();
      } else if (this.actionTime >= TRANSITION_DURATION.anticipate) {
        if (this.pendingJump) this.launchJump();
        else this.setAction('idle');
      }
      return;
    }
    if (this.action === 'land-soft') {
      const resume = this.resumeMotion;
      const moving = resume?.action ?? (this.goal ? this.pace : null);
      const desired = this.landingRoll ? this.facing * Math.min(this.rollSpeed, h * 1.4) : moving ? this.facing * h * (moving === 'sprint' ? 4.6 : moving === 'run' ? 2.6 : 0.85) : 0;
      const result = advance(desired);
      if (result.blocked) {
        this.landingRoll = false;
        this.finishAction('interrupted', 'obstructed'); this.finishMove('interrupted', 'obstructed');
        this.setAction('idle'); return;
      }
      if (result.edge) {
        this.landingRoll = false;
        this.finishAction('completed', 'edge'); this.finishMove('interrupted', 'edge');
        this.setAction('idle'); return;
      }
      if (this.landingRoll && this.actionTime >= LAND_DURATION * 0.55) {
        if (this.fitsRoll(surface, this.support!.u, this.facing)) { this.landingRoll = false; this.setAction('roll'); return; }
        this.landingRoll = false;
      }
      if (this.actionTime >= LAND_DURATION) this.completeLanding();
      return;
    }
    if (this.action === 'roll') {
      const progress = Math.min(1, this.actionTime / this.rollDuration);
      const result = advance(this.facing * this.rollSpeed * Math.sin(Math.PI * progress), h * 24);
      if (result.blocked || result.edge) {
        this.finishAction('interrupted', result.blocked ? 'obstructed' : 'edge');
        this.finishMove('interrupted', result.blocked ? 'obstructed' : 'edge');
        this.setAction('stand-up'); return;
      }
      if (progress >= 1) this.completeLanding();
      return;
    }
    if (this.action === 'wave' || this.action === 'crouch' || this.action === 'rest' || this.action === 'prone') {
      if (this.actionTime >= this.poseDuration) {
        this.standThen(() => { this.setAction('idle'); this.finishAction('completed'); this.decisionAt = this.simulationTime + 0.7; });
      }
      return;
    }
    if (this.action === 'walk' || this.action === 'run' || this.action === 'sprint') {
      const speed = h * (this.action === 'sprint' ? this.dash?.long ? 8 : 4.6 : this.action === 'run' ? 2.6 : 0.85);
      const dash = this.dash;
      const step = this.goal ? this.route[0] : null;
      if (!dash && this.goal && (!step || step.kind !== 'walk' || step.surfaceId !== surface.id || step.sourceRevision !== surface.sourceRevision)) {
        this.stopThen(() => { this.replanMove(); this.setAction('idle'); });
        return;
      }
      const destinationU = dash ? dash.phase === 'position' ? dash.startU : dash.launchU : step?.u;
      const destination = destinationU === undefined ? null : this.pointOn(surface, destinationU).x;
      const dx = destination === null ? 0 : destination - this.body!.position.x;
      const acceleration = h * (dash?.phase === 'run' ? 18 : 10);
      const desired = dash?.phase === 'run' ? dash.direction * dash.speed : destination === null
        ? this.actionTime < this.walkDuration ? this.facing * speed : 0
        : Math.sign(dx) * Math.min(speed, Math.sqrt(2 * acceleration * Math.max(0, Math.abs(dx) - 0.05)));
      const previousSpeed = this.body!.velocity.x;
      const result = advance(desired, acceleration);
      if (result.blocked) {
        this.finishAction('interrupted', 'obstructed');
        this.finishMove('interrupted', 'obstructed');
        this.setAction('idle');
        return;
      }
      if (dash) {
        const remaining = (this.pointOn(surface, dash.launchU).x - this.body!.position.x) * dash.direction;
        if (dash.phase === 'position' && destination !== null && Math.abs(destination - this.body!.position.x) < 0.5 && Math.abs(this.body!.velocity.x) < 1.5) {
          this.body!.velocity.x = 0;
          this.startDashRun();
        } else if (dash.phase === 'run' && result.edge) {
          this.body!.velocity.x = previousSpeed;
          this.queueJump(dash.target, dash.long);
          this.launchJump();
        } else if (dash.phase === 'run' && remaining <= Math.abs(this.body!.velocity.x) * (TRANSITION_DURATION.anticipate + dt / 2) + 0.05) {
          this.queueJump(dash.target, dash.long);
        }
        return;
      }
      if (step && destination !== null && Math.abs(destination - this.body!.position.x) < 0.5 && Math.abs(this.body!.velocity.x) < 1.5) {
        this.body!.velocity.x = 0;
        this.route.shift();
        this.beginRouteStep();
        return;
      }
      if (result.edge) {
        this.setAction('idle');
        this.finishAction('completed', 'edge');
        if (this.goal) this.replanMove();
        this.decisionAt = this.simulationTime + 0.7;
      } else if (!step && desired === 0 && Math.abs(this.body!.velocity.x) < 0.5) {
        this.setAction('idle');
        this.finishAction('completed');
        this.decisionAt = this.simulationTime + 0.7;
      }
    }
    if (this.goal?.automatic && this.simulationTime >= this.goalChangeAt && !this.dash && (this.action === 'idle' || this.action === 'walk' || this.action === 'run' || this.action === 'sprint')) {
      this.goalChangeAt = this.simulationTime + 6 + this.random() * 8;
      if (this.random() < 0.25) this.chooseRandomGoal(viewport);
    }
    if (this.action === 'idle' && this.goal) {
      if (!this.route.length) this.replanMove();
      if (this.goal) this.beginRouteStep();
    } else if (this.action === 'idle' && this.autonomous && !this.reduced && !this.pendingAction && !this.pendingMove && this.simulationTime >= this.decisionAt) {
      this.decisionAt = this.simulationTime + 0.8;
      const choice = this.decisions++ > 0 ? this.random() : 1;
      const pose = choice < 0.06 ? 'wave' : choice < 0.09 ? 'rest' : choice < 0.11 ? 'crouch' : choice < 0.12 && this.fitsProne(surface, this.support!.u, this.facing) ? 'prone' : null;
      if (pose) { this.poseDuration = POSE_DURATION[pose]; this.setAction(pose); }
      else if (!this.chooseRandomGoal(viewport)) {
        const interval = surface.available.find((range) => this.support!.u >= range.start && this.support!.u <= range.end)!;
        const direction: 1 | -1 = this.support!.u - interval.start > interval.end - this.support!.u ? -1 : 1;
        this.resumeMotion = { action: 'run', duration: 1.5 };
        this.beginDash(null, true, direction);
      }
    }
  }


  private completeLanding(): void {
    const resume = this.resumeMotion;
    this.finishAction('completed');
    if (this.goal) {
      this.route = [];
      this.replanMove();
      if (this.goal) this.beginRouteStep();
      else this.setAction('idle');
    } else if (resume) {
      this.walkDuration = resume.duration;
      this.setAction(resume.action);
    } else this.stopThen(() => this.setAction('idle'));
    this.decisionAt = this.simulationTime + 0.7;
  }

  private completeTransition(): void {
    const next = this.afterTransition;
    this.afterTransition = null;
    if (next) next();
    else { this.setAction('idle'); this.finishAction('completed'); }
  }

  private navigationPhysics(pace = this.pace): NavigationPhysics {
    const h = this.appearance.height;
    return { gravity: this.physics.gravity, upwardSpeed: this.jumpSpeed(), maxHorizontalSpeed: h * 4.6, longUpwardSpeed: this.jumpSpeed(true), longHorizontalSpeed: h * 8, acceleration: h * 18, anticipation: TRANSITION_DURATION.anticipate, walkSpeed: h * (pace === 'sprint' ? 4.6 : pace === 'run' ? 2.6 : 0.85), footRadius: h * 0.26, bodyHeight: h };
  }

  private beginRouteStep(): void {
    if (!this.goal || !this.support || !this.body) return;
    const step = this.route[0];
    if (!step) { this.setAction('idle'); this.finishMove('completed'); return; }
    const surface = this.store!.get(step.surfaceId);
    if (!surface || surface.status !== 'valid' || surface.sourceRevision !== step.sourceRevision || !this.fits(surface, step.u)) { this.replanMove(); this.setAction('idle'); return; }
    if (step.kind === 'walk') {
      if (step.surfaceId !== this.support.surfaceId) { this.replanMove(); return; }
      const dx = this.pointOn(surface, step.u).x - this.body.position.x;
      if (Math.abs(dx) < 0.5) {
        if (Math.abs(this.body.velocity.x) >= 0.5) this.stopThen(() => this.beginRouteStep());
        else { this.route.shift(); this.beginRouteStep(); }
        return;
      }
      const direction = dx < 0 ? -1 : 1;
      const start = () => { this.walkDuration = Infinity; this.setAction(this.pace); };
      if (direction !== this.facing) this.stopThen(() => this.beginTurn(direction, start));
      else start();
    } else if (step.kind === 'drop') {
      this.stopThen(() => { this.targetId = step.surfaceId; this.targetRevision = step.sourceRevision; this.dropSupport(); });
    } else {
      const source = this.store!.get(this.support.surfaceId)!;
      const takeoff = planTakeoff(source, step.takeoff?.launchU ?? this.support.u, this.pointOn(surface, step.u), this.navigationPhysics(), step.takeoff?.long ?? false, this.store!.snapshots(), surface.id);
      if (!takeoff) { this.finishMove('interrupted', 'path-changed'); this.setAction('idle'); return; }
      if (this.pace !== 'walk') this.resumeMotion = { action: this.pace, duration: 1.5 };
      const direction: 1 | -1 = takeoff.velocity.x < 0 ? -1 : 1;
      this.stopThen(() => this.beginDash(step, takeoff.long, direction, takeoff));
    }
  }

  private replanMove(): void {
    if (!this.goal || !this.support) return;
    this.pendingJump = null; this.afterTransition = null;
    this.dash = null; this.resumeMotion = null;
    this.targetId = null; this.targetRevision = null;
    const route = findRoute(this.store!.snapshots(), this.support, this.goal, this.navigationPhysics());
    if (!route) { this.finishMove('interrupted', 'unreachable'); return; }
    this.route = route;
  }

  private chooseRandomGoal(viewport: Viewport): boolean {
    if (!this.support || !this.body || this.pendingMove || this.pendingAction) return false;
    const origin = this.body.position;
    const h = this.appearance.height;
    const surfaces = this.store!.snapshots();
    const routes = reachableRoutes(surfaces, this.support, this.navigationPhysics()).flatMap((candidate) => {
      const surface = this.store!.get(candidate.target.surfaceId);
      if (!surface || surface.a.y - h < viewport.top || surface.id === this.support!.surfaceId || surface.id === this.goal?.surfaceId) return [];
      const point = this.pointOn(surface, candidate.target.u);
      const distance = Math.hypot(point.x - origin.x, point.y - origin.y);
      const visits = this.visits.get(surface.id) ?? 0;
      const weight = Math.min(6, Math.max(1, distance / (h * 3))) / ((1 + visits * 1.8) * (1 + candidate.cost * 0.04));
      return [{ ...candidate, surface, weight }];
    });
    if (routes.length) {
      let selection = this.random() * routes.reduce((sum, candidate) => sum + candidate.weight, 0);
      let picked = routes.at(-1)!;
      for (const candidate of routes) { selection -= candidate.weight; if (selection <= 0) { picked = candidate; break; } }
      this.goal = { ...picked.target, sourceRevision: picked.surface.sourceRevision, automatic: true };
      this.route = picked.route;
      this.pace = this.random() < 0.35 ? 'run' : 'walk';
      this.localGoals = 0;
      this.goalChangeAt = this.simulationTime + 8 + this.random() * 10;
      this.emit('targetchange', { target: this.pointOn(picked.surface, picked.target.u) });
      this.stopThen(() => this.beginRouteStep());
      return true;
    }
    if (this.localGoals >= 2) { this.localGoals = 0; return false; }
    const current = this.store!.get(this.support.surfaceId)!;
    const interval = current.available.find((range) => this.support!.u >= range.start && this.support!.u <= range.end)!;
    const margin = h * 0.26 / (current.b.x - current.a.x);
    const direction = this.support.u - interval.start < interval.end - this.support.u ? 1 : -1;
    const u = direction === 1
      ? interval.start + margin + (interval.end - interval.start - margin * 2) * (0.7 + this.random() * 0.25)
      : interval.start + margin + (interval.end - interval.start - margin * 2) * (0.05 + this.random() * 0.25);
    if (Math.abs(u - this.support.u) * (current.b.x - current.a.x) < h) return false;
    const goal = { surfaceId: current.id, sourceRevision: current.sourceRevision, u, automatic: true };
    const route = findRoute(surfaces, this.support, goal, this.navigationPhysics());
    if (!route) return false;
    this.localGoals++;
    this.goal = goal; this.route = route; this.pace = 'walk';
    this.goalChangeAt = this.simulationTime + 10;
    this.emit('targetchange', { target: this.pointOn(current, u) });
    this.stopThen(() => this.beginRouteStep());
    return true;
  }

  private resolveMoveTarget(target: MoveTarget): { surface: SurfaceSnapshot; u: number } | null {
    if (!target || typeof target !== 'object') return null;
    if (!('position' in target)) return this.resolveTarget(target);
    if (!Number.isFinite(target.position.x) || !Number.isFinite(target.position.y) || (target.coordinateSpace && target.coordinateSpace !== 'viewport' && target.coordinateSpace !== 'document')) return null;
    const point = target.coordinateSpace === 'document' ? toClient(target.position, readFrame({ kind: 'document', document: this.doc! })!) : target.position;
    let best: { surface: SurfaceSnapshot; u: number } | null = null;
    let distance = this.appearance.height * 4;
    for (const surface of this.store!.snapshots()) {
      if (surface.status !== 'valid') continue;
      const width = surface.b.x - surface.a.x;
      for (const interval of surface.available) {
        const margin = this.appearance.height * 0.26 / width;
        if (interval.end - interval.start < margin * 2) continue;
        const u = Math.max(interval.start + margin, Math.min(interval.end - margin, (point.x - surface.a.x) / width));
        const candidate = this.pointOn(surface, u);
        const d = Math.hypot(candidate.x - point.x, candidate.y - point.y);
        if (d < distance && this.fits(surface, u)) { distance = d; best = { surface, u }; }
      }
    }
    return best;
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
      this.body.velocity.y = 0;
      axis = 'y';
    }
    if (axis) {
      this.previousPhysics = null;
      this.entering = true;
      this.enteringTime = 0;
      this.ignoredId = null;
      this.finishAction('interrupted', 'boundary');
      this.finishMove('interrupted', 'boundary');
      this.setAction('fall');
      this.emit('boundary', { axis });
    }
  }

  private resolveTarget(target: PlaceTarget): { surface: SurfaceSnapshot; u: number } | null {
    if (!this.doc || !this.store || !this.root || !target || typeof target !== 'object') return null;
    let surface: SurfaceSnapshot | null;
    let u: number | null;
    if ('nodeType' in target) {
      if (target.ownerDocument !== this.doc || !this.root.contains(target)) return null;
      surface = this.store.measureTarget(target, readViewport(this.doc), this.appearance.height * 0.26);
      u = surface ? this.standingU(surface) : null;
    } else {
      surface = this.store.refresh(target.surfaceId, readViewport(this.doc));
      u = target.u ?? (surface ? this.standingU(surface) : null);
    }
    if (!surface || surface.status !== 'valid' || u === null || !Number.isFinite(u) || !this.fits(surface, u)) return null;
    const point = this.pointOn(surface, u);
    if (point.y - this.appearance.height < readViewport(this.doc).top) return null;
    return { surface, u };
  }

  private standingU(surface: SurfaceSnapshot, preferred = 0.5): number | null {
    const width = surface.b.x - surface.a.x;
    if (surface.status !== 'valid' || width <= 0) return null;
    const margin = this.appearance.height * 0.26 / width;
    let best: number | null = null;
    for (const range of surface.available) {
      if (range.end - range.start < margin * 2) continue;
      const u = Math.max(range.start + margin, Math.min(range.end - margin, preferred));
      if (best === null || Math.abs(u - preferred) < Math.abs(best - preferred)) best = u;
    }
    return best;
  }

  private fitsRoll(surface: SurfaceSnapshot, u: number, direction: 1 | -1, duration = ROLL_DURATION): boolean {
    const x = this.pointOn(surface, u).x;
    const h = this.appearance.height;
    const width = surface.b.x - surface.a.x;
    const distance = h * 3.2 * duration * 2 / Math.PI;
    const left = x - h * 0.55 - (direction === -1 ? distance : 0);
    const right = x + h * 0.55 + (direction === 1 ? distance : 0);
    return surface.available.some((range) => left >= surface.a.x + range.start * width && right <= surface.a.x + range.end * width);
  }

  private fitsProne(surface: SurfaceSnapshot, u: number, facing: 1 | -1): boolean {
    const x = this.pointOn(surface, u).x;
    const width = surface.b.x - surface.a.x;
    const left = x - this.appearance.height * (facing === 1 ? 0.82 : 0.38);
    const right = x + this.appearance.height * (facing === 1 ? 0.38 : 0.82);
    return surface.available.some((range) => left >= surface.a.x + range.start * width && right <= surface.a.x + range.end * width);
  }

  private fits(surface: SurfaceSnapshot, u: number): boolean {
    const length = surface.b.x - surface.a.x;
    const margin = this.appearance.height * 0.26 / length;
    return length > 0 && surface.available.some((interval) => u - margin >= interval.start - 1e-8 && u + margin <= interval.end + 1e-8);
  }

  private pointOn(surface: SurfaceSnapshot, u: number): Point {
    return { x: surface.a.x + (surface.b.x - surface.a.x) * u, y: surface.a.y + (surface.b.y - surface.a.y) * u };
  }

  private anchorTo(surface: SurfaceSnapshot, u: number): void {
    this.previousPhysics = null;
    this.visits.set(surface.id, (this.visits.get(surface.id) ?? 0) + 1);
    if (this.visits.size > 64) this.visits.delete(this.visits.keys().next().value!);
    this.support = { surfaceId: surface.id, sourceRevision: surface.sourceRevision, u };
    this.body = { position: this.pointOn(surface, u), velocity: { x: 0, y: 0 } };
    this.decisionAt = this.simulationTime + 0.8;
    const element = this.store!.element(surface.id)!;
    this.motionFrame = selectFrame(element);
    this.saveLocalPosition();
    this.emit('surfacechange', { support: { ...this.support } });
  }

  private releaseSupport(): void {
    this.previousPhysics = null;
    if (this.support) this.emit('surfacechange', { support: null });
    this.support = null;
    this.pendingJump = null;
    this.afterTransition = null;
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
    this.previousPhysics = null;
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

  private bindAbort(signal: AbortSignal | undefined, kind: 'move' | 'action'): void {
    if (!signal) return;
    const abort = () => {
      if (kind === 'move') {
        this.finishMove('interrupted', 'aborted');
        this.resumeMotion = null;
        if (this.support && !this.pendingAction) this.readyThen(() => this.setAction('idle'));
      } else {
        this.finishAction('interrupted', 'aborted');
        if (this.support) this.readyThen(() => {
          if (this.goal) { this.replanMove(); this.beginRouteStep(); }
          else this.setAction('idle');
        });
      }
      this.schedule();
      this.flushEvents();
    };
    signal.addEventListener('abort', abort, { once: true });
    const cleanup = () => signal.removeEventListener('abort', abort);
    if (kind === 'move') this.moveAbort = cleanup;
    else this.actionAbort = cleanup;
  }

  private finishAction(status: ActionResult['status'], reason?: string): void {
    this.actionAbort?.();
    this.actionAbort = null;
    this.pendingAction?.({ status, ...(reason ? { reason } : {}) });
    this.pendingAction = null;
    this.pendingJump = null;
    this.actionTarget = null;
    this.dash = null;
    this.landingRoll = false;
    this.resumeMotion = null;
    const hadTarget = this.explorationTarget !== null || this.targetId !== null;
    this.explorationTarget = null;
    this.afterTransition = null;
    this.targetId = null;
    this.targetRevision = null;
    if (hadTarget && !this.goal) this.emit('targetchange', { target: null });
  }

  private finishMove(status: ActionResult['status'], reason?: string): void {
    if (!this.goal && !this.pendingMove) return;
    this.moveAbort?.();
    this.moveAbort = null;
    this.pendingMove?.({ status, ...(reason ? { reason } : {}) });
    this.pendingMove = null;
    this.goal = null;
    this.route = [];
    if (!this.pendingAction) {
      this.pendingJump = null;
      this.afterTransition = null;
      this.targetId = null;
      this.targetRevision = null;
      this.dash = null;
      this.resumeMotion = null;
      this.landingRoll = false;
      if (this.action === 'walk' || this.action === 'run' || this.action === 'sprint') this.walkDuration = this.actionTime;
    }
    this.decisionAt = this.simulationTime + 0.8 + this.random();
    this.emit('targetchange', { target: null });
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
    this.previousPhysics = null;
  }

  private random(): number {
    this.seed += 0x6d2b79f5;
    let value = this.seed;
    value = Math.imul(value ^ value >>> 15, value | 1);
    value ^= value + Math.imul(value ^ value >>> 7, value | 61);
    return ((value ^ value >>> 14) >>> 0) / 4294967296;
  }
}
