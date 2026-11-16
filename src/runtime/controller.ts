import { createPose, samplePose, LAND_DURATION, ROLL_DURATION, CLIMB_GRAB_DURATION, POSE_DURATION, STAND_DURATION, TURN_DURATION, TRANSITION_DURATION } from '../animation/rig';
import { fromClient, isViewportMount, readFrame, readViewport, selectFrame, toClient } from '../coordinates/frames';
import type { FrameTransform, MotionFrame } from '../coordinates/frames';
import { climbInterval, climbRoot, firstCollision, planJump, stepClimb, stepFlight, stepWalk } from '../motion/solver';
import { createPlanningJob, firstLanding, planTakeoff } from '../motion/navigation';
import type { NavigationPhysics, NavigationStep, NavigationTarget, PlanningJob, TakeoffPlan } from '../motion/navigation';
import { CanvasRenderer } from '../rendering/canvas';
import { SurfaceStore } from '../scene/store';
import type { Anchor, Body, ClimbContact, Point, SurfaceSnapshot, Viewport } from '../scene/types';
import type { ActionId, ActionOptions, ActionResult, Appearance, Diagnostics, NavigationDecision, NavigationDiagnostics, LifecycleStatus, MoveOptions, MoveTarget, PauseReason, Physics, Recognition, PlaceResult, PlaceTarget, StartResult, StickFigure, StickFigureEvents, StickFigureOptions, StickFigureSnapshot } from '../types';
import { FixedStepClock } from './scheduler';
import { recentPenalty } from './autonomy';

const ACTIONS: readonly ActionId[] = ['idle', 'walk', 'run', 'sprint', 'turn', 'wave', 'crouch', 'rest', 'prone', 'stand-up', 'jump', 'run-jump', 'running-long-jump', 'fall', 'land-soft', 'roll', 'sit', 'question', 'run-in-place', 'climb'];
const CLIMB_SPEED_FACTOR = 0.4;
type JumpTarget = NavigationTarget & { sourceRevision: number };
type MovingAction = 'walk' | 'run' | 'sprint';
type PendingEvent = { type: keyof StickFigureEvents; payload: StickFigureEvents[keyof StickFigureEvents] };

interface PhysicsSample {
  position: Point;
  velocity: Point;
  support: Anchor | null;
  climb: ClimbContact | null;
  frame: MotionFrame | null;
  action: ActionId;
  actionTime: number;
  time: number;
  distance: number;
  climbDistance: number;
  climbAttachTime: number;
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
  private walkDuration = 0;
  private goal: (NavigationTarget & { sourceRevision: number; automatic: boolean; climbAction?: boolean }) | null = null;
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
  private planning: PlanningJob | null = null;
  private planningAnchor: Anchor | null = null;
  private readonly navigationBudget: number;
  private navigation: NavigationDiagnostics = { status: 'waiting', goalId: 0, distance: null, reason: 'created', planningMs: 0, candidates: 0, expanded: 0, checkedEdges: 0, replans: 0, history: [] };
  private readonly decisionHistory: NavigationDecision[] = [];
  private nextGoalId = 0;
  private retryAt = 0;
  private retries = 0;
  private exploring = false;
  private restUntil = 0;
  private descentDistance = 0;
  private climb: ClimbContact | null = null;
  private climbDistance = 0;
  private climbAttachTime = 0;
  private climbFlight: NavigationStep | null = null;
  private landStrength = 0;
  private rollSpeed = 0;
  private rollDuration = ROLL_DURATION;
  private poseDuration = 0;
  private readonly visits = new Map<string, number>();
  private explorationTarget: Point | null = null;
  private readonly recentSurfaces: string[] = [];
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
  private ignoredFill: Element | null = null;
  private ignoredRevision: number | null = null;
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
    this.appearance = { height: 16, color: '#181818', lineWidth: 1.2, head: 'circle', ...options.appearance };
    this.physics = { gravity: 9.8, jumpHeight: 52, maxFallSpeed: 600, ...options.physics };
    this.recognition = { colorTolerance: 0.01, ...options.recognition };
    positive(this.recognition.colorTolerance, 'recognition.colorTolerance');
    if (this.recognition.colorTolerance > 1) throw new RangeError('colorTolerance 应不超过 1');
    positive(this.physics.gravity, 'physics.gravity');
    if (this.physics.gravity < 4 || this.physics.gravity > 20) throw new RangeError('physics.gravity 应在 4–20 m/s² 之间');
    positive(this.physics.maxFallSpeed, 'physics.maxFallSpeed');
    positive(this.physics.jumpHeight, 'physics.jumpHeight');
    if (typeof (options.autonomous ?? true) !== 'boolean') throw new TypeError('autonomous 必须是布尔值');
    this.autonomous = options.autonomous ?? true;
    positive(this.appearance.height, 'appearance.height');
    positive(this.appearance.lineWidth, 'appearance.lineWidth');
    if (this.appearance.height > 256 || this.appearance.lineWidth > this.appearance.height / 4) throw new RangeError('人物高度应不超过 256，线宽应不超过高度的四分之一');
    if (!['circle', 'square'].includes(this.appearance.head)) throw new TypeError('当前仅支持 circle / square 头型');
    this.navigationBudget = positive(options.performance?.navigationBudgetMs ?? 1, 'navigationBudgetMs');
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
    this.decisionAt = this.simulationTime;
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
    this.climb = null;
    this.planning = null;
    this.decisionHistory.length = 0;
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
    this.visits.clear();
    this.visits.set(resolved.surface.id, 1);
    this.decisionAt = this.simulationTime;
    this.entering = false;
    this.clearIgnored();
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
    return this.startMove(target, options, false);
  }

  private startMove(target: MoveTarget, options: MoveOptions, climbAction: boolean): Promise<ActionResult> {
    if (!this.body || !this.store || !this.doc || this.status !== 'running' || this.pauses.size) return Promise.resolve({ status: 'rejected', reason: 'not-running' });
    if (this.reduced) return Promise.resolve({ status: 'rejected', reason: 'reduced-motion' });
    const pace = options.pace ?? 'walk';
    if (!['walk', 'run', 'sprint'].includes(pace)) return Promise.resolve({ status: 'rejected', reason: 'unsupported-pace' });
    if (options.signal?.aborted) return Promise.resolve({ status: 'interrupted', reason: 'aborted' });
    const resolved = this.resolveMoveTarget(target);
    if (!resolved) return Promise.resolve({ status: 'rejected', reason: 'no-visible-support' });
    const goal = { surfaceId: resolved.surface.id, u: resolved.u, sourceRevision: resolved.surface.sourceRevision, automatic: false, climbAction };
    this.finishAction('interrupted', 'move-requested');
    this.finishMove('interrupted', 'replaced');
    const promise = new Promise<ActionResult>((resolve) => { this.pendingMove = resolve; });
    this.bindAbort(options.signal, 'move');
    this.goal = goal;
    this.route = [];
    this.pace = pace;
    this.navigation.goalId = ++this.nextGoalId;
    this.retries = 0;
    this.exploring = false;
    this.restUntil = 0;
    this.emit('targetchange', { target: this.pointOn(resolved.surface, resolved.u) });
    if (this.support) this.readyThen(() => this.replanMove());
    else if (this.climb) this.replanMove();
    else this.setNavigation('planning', 'awaiting-contact');
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
    if (action === 'climb') {
      const target = options.target ? this.resolveClimbTarget(options.target) : this.nearestClimb();
      if (!target) return Promise.resolve({ status: 'rejected', reason: 'no-visible-climb' });
      return this.startMove({ surfaceId: target.surface.id, u: target.u }, { pace: 'run', ...(options.signal ? { signal: options.signal } : {}) }, true);
    }
    if (this.climb && action === 'idle') {
      this.finishAction('interrupted', 'replaced');
      this.finishMove('interrupted', 'action-requested');
      this.body.velocity = { x: 0, y: 0 };
      return Promise.resolve({ status: 'completed' });
    }
    if (this.climb && action === 'fall') {
      this.finishMove('interrupted', 'action-requested');
      this.releaseClimb();
      this.setAction('fall');
      return Promise.resolve({ status: 'completed' });
    }
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
    if (action === 'sit' && !this.fitsSit(current, this.support.u, direction)) return Promise.resolve({ status: 'rejected', reason: 'insufficient-space' });
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
    } else if (action === 'wave' || action === 'crouch' || action === 'rest' || action === 'prone' || action === 'sit' || action === 'question' || action === 'run-in-place') {
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
    if (this.action === 'crouch' || this.action === 'sit' || this.action === 'prone' || this.action === 'roll' || this.pose.crouch > 0.1 || this.pose.sit > 0.1 || this.pose.prone > 0.1 || this.pose.roll > 0.1 || Math.abs(Math.sin(this.pose.rollAngle / 2)) > 0.1) {
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

  private get gravityPixels(): number {
    return this.physics.gravity * 100;
  }

  private jumpSpeed(long = false): number {
    return Math.sqrt(2 * this.gravityPixels * this.physics.jumpHeight * (long ? 1.65 : 1));
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
    const velocity = { x: this.body.velocity.x, y: this.climbFlight?.kind === 'grab' ? this.climbFlight.takeoff!.velocity.y : -this.jumpSpeed(jump.long) };
    if (Math.abs(velocity.x) > 0.5 && Math.sign(velocity.x) !== this.facing) {
      this.readyThen(() => this.queueJump(jump.target, jump.long));
      return;
    }
    if (jump.target) {
      const surface = this.store!.refresh(jump.target.surfaceId, readViewport(this.doc!));
      if (!surface || surface.status !== 'valid' || surface.sourceRevision !== jump.target.sourceRevision) {
        this.finishAction('interrupted', 'target-invalid'); this.finishMove('interrupted', 'target-invalid'); this.setAction('idle'); return;
      }
      const landing = this.climbFlight?.kind === 'grab'
        ? firstCollision({ position: this.body.position, velocity }, this.store!.snapshots(), Infinity, this.gravityPixels, this.appearance.height * 0.26, this.appearance.height, this.physics.maxFallSpeed, undefined, undefined, surface.id)
        : firstLanding(this.body.position, velocity, this.store!.snapshots(), this.gravityPixels, this.appearance.height * 0.26, undefined, this.appearance.height, undefined, this.physics.maxFallSpeed);
      const error = landing ? Math.abs(landing.u - jump.target.u) * Math.hypot(surface.b.x - surface.a.x, surface.b.y - surface.a.y) : Infinity;
      if (landing?.surfaceId !== surface.id || error > this.appearance.height * 0.4) {
        this.finishAction('interrupted', 'path-changed'); this.finishMove('interrupted', 'path-changed'); this.stopThen(() => this.setAction('idle')); return;
      }
    }
    if (jump.long && !jump.target) {
      const time = this.jumpSpeed(true) * 2 / this.gravityPixels;
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
    this.ignoredRevision = this.support!.sourceRevision;
    const surface = this.store!.get(this.ignoredId)!;
    this.ignoredFill = surface.kind === 'fill' ? this.store!.element(surface.id) : null;
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
      climb: this.climb ? { ...this.climb, normal: { ...this.climb.normal } } : null,
      navigation: {
        ...this.navigation,
        distance: this.body && targetSurface && selectedTarget ? Math.hypot(this.pointOn(targetSurface, selectedTarget.u).x - this.body.position.x, this.pointOn(targetSurface, selectedTarget.u).y - this.body.position.y) : null,
        history: this.options.debug ? this.decisionHistory.map((entry) => ({ ...entry, target: entry.target ? { ...entry.target } : null })) : [],
      },
      target: selectedTarget && targetSurface ? { surfaceId: selectedTarget.surfaceId, u: selectedTarget.u, position: this.pointOn(targetSurface, selectedTarget.u) } : this.explorationTarget && explorationFrame ? { position: toClient(this.explorationTarget, explorationFrame) } : null,
      path,
      surfaces: surfaces.map((surface) => ({ ...surface, ...(surface.normal ? { normal: { ...surface.normal } } : {}), a: { ...surface.a }, b: { ...surface.b }, available: surface.available.map((range) => ({ ...range })), ...(surface.bounds ? { bounds: { ...surface.bounds } } : {}) })),
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
    const viewChanged = () => { this.viewChanged = true; this.store?.invalidateGeometry(); this.schedule(); };
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
      if (this.reduced) {
        this.finishAction('interrupted', 'reduced-motion');
        this.finishMove('interrupted', 'reduced-motion');
        if (this.support || this.climb) this.body!.velocity = { x: 0, y: 0 };
        if (this.support) this.setAction('idle');
      }
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
    if (this.climb) this.store.pinned.add(this.climb.surfaceId);
    if (this.targetId) this.store.pinned.add(this.targetId);
    if (this.goal) this.store.pinned.add(this.goal.surfaceId);
    if (this.ignoredId) {
      this.store.pinned.add(this.ignoredId);
      const source = this.store.refresh(this.ignoredId, viewport);
      if (!source || source.status === 'invalid' || source.sourceRevision !== this.ignoredRevision) this.clearIgnored();
    }
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
        this.syncPendingContactPosition();
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
    if (this.climb) {
      const surface = this.store.refresh(this.climb.surfaceId, viewport);
      if (!surface || surface.status === 'invalid' || surface.sourceRevision !== this.climb.sourceRevision) {
        this.finishAction('interrupted', 'support-invalid');
        this.finishMove('interrupted', 'support-invalid');
        this.releaseClimb();
        this.setAction('fall');
        this.pauses.delete('offscreen');
        this.pauses.delete('verification');
      } else if (surface.status === 'unknown') {
        this.syncPendingContactPosition();
        if (++this.unknownFrames >= 2) { this.pauses.add('verification'); this.sleep(); return; }
      } else {
        this.unknownFrames = 0;
        this.pauses.delete('verification');
        this.climb.normal = { ...surface.normal! };
        this.body!.position = climbRoot(surface, this.climb.u, this.appearance.height);
        this.saveLocalPosition();
        if (surface.status === 'offscreen') { this.pauses.add('offscreen'); this.sleep(); return; }
        this.pauses.delete('offscreen');
        if (!this.fits(surface, this.climb.u)) { this.releaseClimb(); this.setAction('fall'); }
      }
    }
    if (this.body && !this.support && !this.climb && this.motionFrame && this.localPosition) {
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
    // Foreground support verification above is mandatory. Background discovery
    // and neighborhood refresh share the remaining perception budget instead of
    // adding up to 32 unbudgeted DOM measurements after a full scan slice.
    const remaining = Math.max(0, this.budget - (scanStart - started));
    const left = () => Math.max(0, remaining - (performance.now() - scanStart));
    if (this.body) this.store.discoverNearby(this.body.position, this.appearance.height * 8, viewport, remaining / 3);
    const scanBudget = left();
    if (scanBudget > 0) this.store.scan(viewport, this.body ? scanBudget / 2 : scanBudget);
    if (this.body) this.store.refreshNearby(this.body.position, this.appearance.height * 8, viewport, left());
    this.metrics.scanMs = performance.now() - scanStart;
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
      if (goal?.status === 'unknown' && goal.sourceRevision === this.goal.sourceRevision) {
        if (this.support || this.climb) { this.pauses.add('verification'); this.sleep(); return; }
      } else if (!goal || goal.status !== 'valid' || goal.sourceRevision !== this.goal.sourceRevision || !this.fits(goal, this.goal.u)) this.finishMove('interrupted', 'target-invalid');
    }
    if (this.targetId) {
      const target = this.store.refresh(this.targetId, viewport);
      if (target?.status === 'unknown' && target.sourceRevision === this.targetRevision) {
        if (this.support || this.climb) { this.pauses.add('verification'); this.sleep(); return; }
      } else if (!target || target.status !== 'valid' || target.sourceRevision !== this.targetRevision) {
        this.finishAction('interrupted', 'target-invalid');
        if (this.goal) this.finishMove('interrupted', 'target-invalid');
        if (this.support) this.readyThen(() => this.setAction('idle'));
      }
    }
    // 下穿填充实体时，其内部文字不是独立的下一层地面。
    const ignoredBounds = this.ignoredId ? this.store.get(this.ignoredId)?.bounds : undefined;
    let surfaces = this.store.snapshots().filter((surface) => {
      if (surface.id === this.ignoredId) return false;
      if (!this.ignoredFill || !ignoredBounds || surface.a.y < ignoredBounds.top || surface.a.y > ignoredBounds.bottom) return true;
      const owner = this.store!.element(surface.id);
      return !owner || !this.ignoredFill.contains(owner);
    });
    if (!this.support && !this.climb) {
      const contactStart = performance.now();
      surfaces = this.collisionSurfaces(surfaces, viewport);
      this.metrics.scanMs += performance.now() - contactStart;
    }
    this.tickAutonomy(viewport);
    if (this.goal && !this.planning && !this.route.length && this.simulationTime >= this.retryAt) this.replanMove();
    this.advanceNavigation();
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
        climb: this.climb ? { ...this.climb, normal: { ...this.climb.normal } } : null,
        frame: sampledTransform ? sampledFrame : null,
        action: this.action,
        actionTime: this.actionTime,
        time: this.simulationTime,
        distance: this.gaitDistance,
        climbDistance: this.climbDistance,
        climbAttachTime: this.climbAttachTime,
      };
      this.simulationTime += dt;
      this.actionTime += dt;
      if (this.support) {
        this.stepGround(dt, surfaces);
        return;
      }
      if (this.climb) {
        this.stepClimbing(dt);
        return;
      }
      const beforeY = this.body!.position.y;
      const result = stepFlight(this.body!, surfaces, dt, this.gravityPixels, this.physics.maxFallSpeed, this.appearance.height * 0.26, this.appearance.height, this.climbFlight?.kind === 'grab' ? this.climbFlight.surfaceId : undefined);
      this.descentDistance = result.body.position.y < beforeY ? 0 : this.descentDistance + result.body.position.y - beforeY;
      this.body = result.body;
      if (result.climb) {
        this.anchorClimb(this.store!.get(result.climb.surfaceId)!, result.climb.u);
        if (this.route[0]?.kind === 'grab') this.route.shift();
        this.climbFlight = null;
        this.targetId = null;
        this.targetRevision = null;
        if (this.route.length) this.beginRouteStep();
        else this.replanMove();
        if (result.remainingTime > 0) {
          this.actionTime += result.remainingTime;
          this.stepClimbing(result.remainingTime);
        }
        return;
      }
      if (this.ignoredId) {
        this.ignoredTime += dt;
        const source = this.store!.get(this.ignoredId);
        const passed = source && (this.ignoredFill && source.bounds
          ? this.body.position.y - this.appearance.height > source.bounds.bottom
          : this.body.position.y > source.a.y + 1);
        if (!source || passed || this.ignoredTime > 5) this.clearIgnored();
      }
      if (result.landing) {
        this.clearIgnored();
        const surface = this.store!.get(result.landing.surfaceId)!;
        const speed = result.body.velocity.x;
        const direction: 1 | -1 = Math.abs(speed) > 0.5 ? speed < 0 ? -1 : 1 : this.facing;
        const high = this.descentDistance > Math.max(this.physics.jumpHeight * 1.2, this.appearance.height * 4);
        this.landStrength = Math.min(1, result.landing.impactSpeed / (this.jumpSpeed() * 1.5));
        this.rollDuration = ROLL_DURATION;
        this.anchorTo(surface, result.landing.u);
        const rolling = high && this.fitsRoll(surface, result.landing.u, direction);
        if (this.resumeMotion || this.goal || rolling) this.body.velocity.x = speed;
        if (rolling) {
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
        this.climbFlight = null;
        this.setAction(rolling ? 'roll' : 'land-soft');
        if (result.remainingTime > 0) {
          this.actionTime += result.remainingTime;
          this.stepGround(result.remainingTime, surfaces);
        }
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
    let renderClimbDistance = this.climbDistance;
    let renderClimbAttachTime = this.climbAttachTime;
    let renderTime = this.simulationTime;
    let renderActionTime = this.actionTime;
    let renderVelocity = this.body!.velocity;
    const previous = this.previousPhysics;
    if (previous) {
      if (this.support && previous.support && this.support.surfaceId === previous.support.surfaceId && this.support.sourceRevision === previous.support.sourceRevision) {
        const surface = this.store.get(this.support.surfaceId)!;
        if (surface.status === 'valid') renderPosition = this.pointOn(surface, previous.support.u + (this.support.u - previous.support.u) * alpha);
      } else if (this.climb && previous.climb && this.climb.surfaceId === previous.climb.surfaceId && this.climb.sourceRevision === previous.climb.sourceRevision) {
        const surface = this.store.get(this.climb.surfaceId)!;
        if (surface.status === 'valid') renderPosition = climbRoot(surface, previous.climb.u + (this.climb.u - previous.climb.u) * alpha, this.appearance.height);
      } else if (!this.support && !this.climb && !previous.support && !previous.climb && previous.frame && previous.frame === this.motionFrame) {
        const transform = readFrame(previous.frame);
        if (transform) {
          const origin = toClient(previous.position, transform);
          renderPosition = { x: origin.x + (this.body!.position.x - origin.x) * alpha, y: origin.y + (this.body!.position.y - origin.y) * alpha };
        }
      }
      renderDistance = previous.distance + (this.gaitDistance - previous.distance) * alpha;
      renderClimbDistance = previous.climbDistance + (this.climbDistance - previous.climbDistance) * alpha;
      renderClimbAttachTime = previous.climbAttachTime + (this.climbAttachTime - previous.climbAttachTime) * alpha;
      renderTime = previous.time + (this.simulationTime - previous.time) * alpha;
      renderVelocity = { x: previous.velocity.x + (this.body!.velocity.x - previous.velocity.x) * alpha, y: previous.velocity.y + (this.body!.velocity.y - previous.velocity.y) * alpha };
      if (previous.action === this.action && previous.actionTime <= this.actionTime) renderActionTime = previous.actionTime + (this.actionTime - previous.actionTime) * alpha;
    }
    let reach: { normal: Point; distance: number; progress: number } | undefined;
    if (!this.climb && this.climbFlight?.kind === 'grab') {
      const surface = this.store.get(this.climbFlight.surfaceId);
      if (surface?.status === 'valid' && surface.normal) {
        const normal = surface.normal;
        const distance = (renderPosition.x - surface.a.x) * normal.x + (renderPosition.y - surface.a.y) * normal.y;
        if (renderVelocity.x * normal.x + renderVelocity.y * normal.y < 0) {
          reach = { normal, distance, progress: Math.max(0, Math.min(1, 1 - Math.max(0, distance - this.appearance.height * 0.26) / (this.appearance.height * 2))) };
        }
      }
    }
    samplePose(this.pose, {
      height: this.appearance.height, action: this.action, time: renderActionTime,
      clock: renderTime, dt, verticalVelocity: renderVelocity.y,
      landProgress: renderActionTime / LAND_DURATION, landStrength: this.landStrength,
      facing: this.facing, distance: renderDistance, horizontalSpeed: renderVelocity.x,
      turnProgress: this.action === 'turn' ? renderActionTime / TURN_DURATION : undefined,
      actionDuration: this.action === 'roll' ? this.rollDuration : this.poseDuration,
      climb: this.climb ? { normal: this.climb.normal, distance: renderClimbDistance, gripProgress: renderClimbAttachTime / CLIMB_GRAB_DURATION } : undefined,
      reach,
    });
    this.renderer.draw(renderPosition, this.pose);
    this.renderer.setVisible(!this.pauses.size);
    this.setStatus(this.pauses.size ? 'paused' : 'running');
    this.finishStart(this.support || this.climb ? 'ready' : 'empty');
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

  private collisionSurfaces(surfaces: SurfaceSnapshot[], viewport: Viewport): SurfaceSnapshot[] {
    let batch = surfaces;
    const verified = new Set<string>();
    const target = this.climbFlight?.kind === 'grab' ? this.climbFlight.surfaceId : undefined;
    const predict = () => stepFlight(this.body!, batch, 6 / 120, this.gravityPixels, this.physics.maxFallSpeed, this.appearance.height * 0.26, this.appearance.height, target);
    for (let pass = 0; pass < 4; pass++) {
      const ids = [...new Set(predict().contacts.map(contact => contact.surfaceId))].filter(id => !verified.has(id));
      if (!ids.length) return batch;
      for (const id of ids) {
        this.store!.pinned.add(id);
        const surface = this.store!.refresh(id, viewport);
        verified.add(id);
        batch = batch.map(old => old.id !== id ? old : surface ?? { ...old, status: 'invalid', available: [] });
      }
    }
    const unknown = new Set(predict().contacts.filter(contact => !verified.has(contact.surfaceId)).map(contact => contact.surfaceId));
    return batch.filter(surface => !unknown.has(surface.id));
  }

  private stepGround(dt: number, surfaces: readonly SurfaceSnapshot[]): void {
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
      if (Math.abs(this.body!.velocity.x) < 0.5 && this.actionTime >= TRANSITION_DURATION.brake) {
        this.body!.velocity.x = 0;
        this.completeTransition();
      }
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
      const desired = moving ? this.facing * h * (moving === 'sprint' ? 4.6 : moving === 'run' ? 2.6 : 0.85) : 0;
      const result = advance(desired);
      if (result.blocked) {
        this.finishAction('interrupted', 'obstructed'); this.finishMove('interrupted', 'obstructed');
        this.setAction('idle'); return;
      }
      if (result.edge) {
        this.finishAction('completed', 'edge'); this.finishMove('interrupted', 'edge');
        this.setAction('idle'); return;
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
    if (this.action === 'wave' || this.action === 'crouch' || this.action === 'rest' || this.action === 'prone' || this.action === 'sit' || this.action === 'question' || this.action === 'run-in-place') {
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
  }


  private completeLanding(): void {
    const resume = this.resumeMotion;
    this.finishAction('completed');
    if (this.goal) {
      this.setAction('idle');
      if (this.route.length) this.beginRouteStep();
      else this.replanMove();
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
    return { gravity: this.gravityPixels, maxFallSpeed: this.physics.maxFallSpeed, climbSpeed: h * CLIMB_SPEED_FACTOR, grabDuration: CLIMB_GRAB_DURATION, climbDestination: this.goal?.climbAction ? this.goal.surfaceId : undefined, upwardSpeed: this.jumpSpeed(), maxHorizontalSpeed: h * 4.6, longUpwardSpeed: this.jumpSpeed(true), longHorizontalSpeed: h * 8, acceleration: h * 18, anticipation: TRANSITION_DURATION.anticipate, walkSpeed: h * (pace === 'sprint' ? 4.6 : pace === 'run' ? 2.6 : 0.85), footRadius: h * 0.26, bodyHeight: h };
  }

  private beginRouteStep(): void {
    if (!this.goal || !(this.support || this.climb) || !this.body || this.planning || this.simulationTime < this.restUntil) return;
    const step = this.route[0];
    if (!step) {
      if (this.exploring) {
        this.exploring = false;
        this.retryAt = this.simulationTime + 0.3;
        this.setNavigation('planning', 'intermediate-reached');
        this.replanMove();
      } else {
        const anchor = this.support ?? this.climb!;
        const target = this.store!.get(this.goal.surfaceId);
        if (anchor.surfaceId !== this.goal.surfaceId || !target || this.distanceTo(target, this.goal.u) > 0.8) this.replanMove();
        else this.finishMove('completed');
      }
      if (!this.climb) this.setAction('idle');
      return;
    }
    const surface = this.store!.get(step.surfaceId);
    if (!surface || surface.status !== 'valid' || surface.sourceRevision !== step.sourceRevision || !this.fits(surface, step.u)) { this.replanMove(); if (!this.climb) this.setAction('idle'); return; }
    if (step.kind === 'climb') {
      if (!this.climb || this.climb.surfaceId !== surface.id) { this.replanMove(); return; }
      this.setAction('climb');
      return;
    }
    if (step.kind === 'climb-jump') {
      if (!this.climb || !step.takeoff) { this.replanMove(); return; }
      const velocity = planJump(this.body.position, this.pointOn(surface, step.u), this.appearance.height * (step.takeoff.long ? 8 : 4.6), this.jumpSpeed(step.takeoff.long), this.gravityPixels, this.physics.maxFallSpeed);
      if (!velocity) { this.finishMove('interrupted', 'path-changed'); return; }
      const landing = firstLanding(this.body.position, velocity, this.store!.snapshots(), this.gravityPixels, this.appearance.height * 0.26, undefined, this.appearance.height, undefined, this.physics.maxFallSpeed);
      if (!landing || landing.surfaceId !== surface.id) { this.finishMove('interrupted', 'path-changed'); return; }
      this.climbFlight = step;
      this.targetId = surface.id;
      this.targetRevision = surface.sourceRevision;
      this.facing = velocity.x < 0 ? -1 : 1;
      this.releaseClimb();
      this.body.velocity = { ...velocity };
      this.setAction('jump');
      this.saveLocalPosition();
      return;
    }
    if (!this.support) { this.replanMove(); return; }
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
      const takeoff = step.kind === 'grab' ? step.takeoff : planTakeoff(source, step.takeoff?.launchU ?? this.support.u, this.pointOn(surface, step.u), this.navigationPhysics(), step.takeoff?.long ?? false, this.store!.snapshots(), surface.id);
      if (!takeoff) { this.finishMove('interrupted', 'path-changed'); this.setAction('idle'); return; }
      this.climbFlight = step.kind === 'grab' ? step : null;
      if (this.pace !== 'walk') this.resumeMotion = { action: this.pace, duration: 1.5 };
      const direction: 1 | -1 = takeoff.velocity.x < 0 ? -1 : 1;
      this.stopThen(() => this.beginDash(step, takeoff.long, direction, takeoff));
    }
  }

  private stepClimbing(dt: number): void {
    if (!this.climb || !this.body) return;
    const surface = this.store!.get(this.climb.surfaceId)!;
    if (surface.status !== 'valid') {
      this.body.velocity = { x: 0, y: 0 };
      return;
    }
    const step = this.route[0];
    const length = Math.hypot(surface.b.x - surface.a.x, surface.b.y - surface.a.y);
    const beforeTime = this.climbAttachTime;
    this.climbAttachTime += dt;
    const drivingTime = Math.min(dt, Math.max(0, this.climbAttachTime - CLIMB_GRAB_DURATION));
    const active = step?.kind === 'climb' && step.surfaceId === surface.id && !this.planning && this.simulationTime >= this.restUntil && this.climbAttachTime >= CLIMB_GRAB_DURATION;
    if (active && beforeTime < CLIMB_GRAB_DURATION) this.setNavigation('moving', 'climb-started');
    const distance = active ? (step.u - this.climb.u) * length : 0;
    const acceleration = this.appearance.height * 1.4;
    const desired = Math.sign(distance) * Math.min(this.appearance.height * CLIMB_SPEED_FACTOR, Math.sqrt(2 * acceleration * Math.max(0, Math.abs(distance) - 0.05)));
    const beforeU = this.climb.u;
    const result = stepClimb(this.body, surface, beforeU, desired, acceleration, drivingTime, this.appearance.height);
    this.body = result.body;
    this.climb.u = result.u;
    this.climbDistance += (beforeU - result.u) * length;
    if (active && Math.abs((step.u - result.u) * length) < 0.5 && Math.hypot(result.body.velocity.x, result.body.velocity.y) < 1.5) {
      this.body.velocity = { x: 0, y: 0 };
      this.route.shift();
      this.beginRouteStep();
    } else if (active && result.edge) this.finishMove('interrupted', 'edge');
  }

  private replanMove(): void {
    const anchor = this.support ?? this.climb;
    if (!this.goal || !anchor || this.planning || this.store!.get(this.goal.surfaceId)?.status !== 'valid') return;
    this.pendingJump = null;
    this.afterTransition = null;
    this.dash = null;
    this.targetId = null;
    this.targetRevision = null;
    this.route = [];
    this.planningAnchor = { surfaceId: anchor.surfaceId, sourceRevision: anchor.sourceRevision, u: anchor.u };
    this.planning = createPlanningJob(this.store!.snapshots(), this.planningAnchor, this.goal, this.navigationPhysics());
    this.navigation.replans++;
    this.setNavigation('planning', this.retries ? 'retry' : 'target-selected');
  }

  private advanceNavigation(): void {
    if (!this.planning) return;
    const anchor = this.support ?? this.climb;
    if (!this.goal || !anchor || anchor.surfaceId !== this.planningAnchor?.surfaceId || anchor.sourceRevision !== this.planningAnchor.sourceRevision || this.planning.target?.surfaceId !== this.goal.surfaceId || this.planning.target.u !== this.goal.u) {
      this.planning = null;
      return;
    }
    const job = this.planning;
    const result = job.advance(this.navigationBudget, 32);
    this.navigation.planningMs = result.elapsedMs;
    this.navigation.candidates = result.candidates;
    this.navigation.expanded = result.expanded;
    this.navigation.checkedEdges = result.checkedEdges;
    if (result.status === 'pending') return;
    this.planning = null;
    if (result.status === 'unreachable' && result.route && this.goal.automatic) {
      this.exploring = true;
      this.setNavigation('planning', 'closer-intermediate');
    } else if (result.status === 'unreachable' || !result.route) {
      if (this.goal.automatic) {
        this.retries++;
        this.retryAt = this.simulationTime + 0.6;
        this.setNavigation('unreachable', 'no-route');
      } else this.finishMove('rejected', 'unreachable');
      return;
    }
    const batch = new Map(job.surfaces.map(surface => [surface.id, surface]));
    const before = batch.get(anchor.surfaceId)!;
    const current = this.store!.get(anchor.surfaceId)!;
    const dx = current.a.x - before.a.x, dy = current.a.y - before.a.y;
    if (result.route?.some((step) => {
      const surface = this.store!.get(step.surfaceId);
      const old = batch.get(step.surfaceId);
      if (!surface || !old || surface.status !== 'valid' || surface.sourceRevision !== step.sourceRevision || !this.fits(surface, step.u)) return true;
      const translated = Math.abs(surface.a.x - old.a.x - dx) < 0.01 && Math.abs(surface.a.y - old.a.y - dy) < 0.01
        && Math.abs(surface.b.x - old.b.x - dx) < 0.01 && Math.abs(surface.b.y - old.b.y - dy) < 0.01;
      const ranges = surface.available.length === old.available.length && surface.available.every((range, i) => Math.abs(range.start - old.available[i]!.start) < 1e-6 && Math.abs(range.end - old.available[i]!.end) < 1e-6);
      const normals = Math.abs((surface.normal?.x ?? 0) - (old.normal?.x ?? 0)) < 1e-6 && Math.abs((surface.normal?.y ?? 0) - (old.normal?.y ?? 0)) < 1e-6;
      const boundsMatch = surface.bounds && old.bounds
        ? Math.abs(surface.bounds.left - old.bounds.left - dx) < 0.01 && Math.abs(surface.bounds.right - old.bounds.right - dx) < 0.01
          && Math.abs(surface.bounds.top - old.bounds.top - dy) < 0.01 && Math.abs(surface.bounds.bottom - old.bounds.bottom - dy) < 0.01
        : !surface.bounds && !old.bounds;
      return !translated || !ranges || !normals || !boundsMatch;
    })) {
      this.retries++;
      this.retryAt = this.simulationTime + 0.3;
      this.setNavigation('planning', 'scene-changed');
      return;
    }
    this.route = result.route!;
    this.retries = 0;
    if (this.simulationTime < this.restUntil) this.setNavigation('resting', 'short-rest');
    else {
      this.setNavigation('moving', 'route-ready');
      if (this.climb) this.beginRouteStep();
      else if (!['roll', 'land-soft', 'anticipate', 'stand-up'].includes(this.action)) this.readyThen(() => this.beginRouteStep());
    }
  }

  private setNavigation(status: NavigationDecision['status'], reason: string): void {
    this.navigation.status = status;
    this.navigation.reason = reason;
    const surface = this.goal ? this.store?.get(this.goal.surfaceId) : null;
    const decision: NavigationDecision = {
      id: this.navigation.goalId, time: this.simulationTime, status, reason,
      target: surface && this.goal ? this.pointOn(surface, this.goal.u) : null,
    };
    if (this.options.debug) {
      this.decisionHistory.push({ ...decision, target: decision.target ? { ...decision.target } : null });
      if (this.decisionHistory.length > 32) this.decisionHistory.shift();
    }
    this.emit('navigationchange', decision);
  }

  private tickAutonomy(viewport: Viewport): void {
    if (this.reduced || this.pendingAction || this.pendingMove) return;
    if (!this.goal && this.autonomous && this.simulationTime >= this.decisionAt) this.chooseRandomGoal(viewport);
    if (!this.goal?.automatic) return;
    if (this.simulationTime >= this.goalChangeAt) {
      this.goalChangeAt = this.simulationTime + 3 + this.random() * 3;
      if (this.random() < 0.05) this.chooseRandomGoal(viewport);
    }
    if (this.retries >= 3 && this.simulationTime >= this.retryAt) this.chooseRandomGoal(viewport);
    if (!this.planning && !this.route.length && this.simulationTime >= this.retryAt) this.replanMove();
    if (this.route.length && this.navigation.status === 'resting' && this.simulationTime >= this.restUntil && (this.action === 'idle' || this.climb)) {
      this.setNavigation('moving', 'rest-finished');
      this.beginRouteStep();
    }
  }

  private chooseRandomGoal(viewport: Viewport): boolean {
    if (!this.body || this.reduced || this.pendingMove || this.pendingAction) return false;
    const h = this.appearance.height;
    const origin = this.body.position;
    const candidates: { surface: SurfaceSnapshot; u: number; weight: number }[] = [];
    for (const surface of this.store!.snapshots()) {
      if (surface.status !== 'valid') continue;
      const preferred = this.random();
      let u = surface.mode === 'climb' ? this.climbingU(surface, preferred) : this.standingU(surface, preferred);
      if (u === null) continue;
      let point = this.pointOn(surface, u);
      if (Math.hypot(point.x - origin.x, point.y - origin.y) < h) {
        const ends = [0, 1].flatMap(preferred => {
          const candidate = surface.mode === 'climb' ? this.climbingU(surface, preferred) : this.standingU(surface, preferred);
          if (candidate === null) return [];
          const point = this.pointOn(surface, candidate);
          if (Math.hypot(point.x - origin.x, point.y - origin.y) < h || point.x < viewport.left || point.x > viewport.right || point.y - h < viewport.top || point.y > viewport.bottom) return [];
          return [{ u: candidate, point }];
        });
        if (!ends.length) continue;
        const end = ends[Math.floor(this.random() * ends.length)]!;
        u = end.u;
        point = end.point;
      }
      const distance = Math.hypot(point.x - origin.x, point.y - origin.y);
      if (distance < h || point.x < viewport.left || point.x > viewport.right || point.y - h < viewport.top || point.y > viewport.bottom) continue;
      const visits = this.visits.get(surface.id) ?? 0;
      const weight = Math.min(6, Math.max(1, distance / (h * 3))) / ((1 + visits * 1.8) * recentPenalty(this.recentSurfaces, surface.id));
      candidates.push({ surface, u, weight });
    }
    if (!candidates.length) {
      this.decisionAt = this.simulationTime + 0.8;
      if (!this.goal) this.setNavigation('waiting', 'no-visible-target');
      return false;
    }
    let selection = this.random() * candidates.reduce((sum, candidate) => sum + candidate.weight, 0);
    let picked = candidates.at(-1)!;
    for (const candidate of candidates) { selection -= candidate.weight; if (selection <= 0) { picked = candidate; break; } }
    this.goal = { surfaceId: picked.surface.id, sourceRevision: picked.surface.sourceRevision, u: picked.u, automatic: true };
    this.navigation.goalId = ++this.nextGoalId;
    this.route = [];
    this.planning = null;
    this.retries = 0;
    this.retryAt = this.simulationTime;
    this.exploring = false;
    this.pace = this.random() < 0.45 ? 'run' : 'walk';
    this.goalChangeAt = this.simulationTime + 3 + this.random() * 3;
    this.emit('targetchange', { target: this.pointOn(picked.surface, picked.u) });
    this.replanMove();
    if (this.support && !this.climbFlight && (this.action === 'idle' || this.action === 'walk' || this.action === 'run' || this.action === 'sprint')) this.stopThen(() => this.setAction('idle'));
    return true;
  }

  private resolveMoveTarget(target: MoveTarget): { surface: SurfaceSnapshot; u: number } | null {
    if (!target || typeof target !== 'object') return null;
    if (!('position' in target)) return this.resolveTarget(target) ?? this.resolveClimbTarget(target);
    if (!Number.isFinite(target.position.x) || !Number.isFinite(target.position.y) || (target.coordinateSpace && target.coordinateSpace !== 'viewport' && target.coordinateSpace !== 'document')) return null;
    const point = target.coordinateSpace === 'document' ? toClient(target.position, readFrame({ kind: 'document', document: this.doc! })!) : target.position;
    let best: { surface: SurfaceSnapshot; u: number } | null = null;
    let distance = this.appearance.height * 4;
    for (const surface of this.store!.snapshots()) {
      if (surface.status !== 'valid' || surface.mode === 'climb') continue;
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
    if (!this.body || this.support || this.climb || this.entering) return;
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
      this.descentDistance = 0;
      axis = 'y';
    }
    if (axis) {
      this.previousPhysics = null;
      this.entering = true;
      this.enteringTime = 0;
      this.clearIgnored();
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
    if (!surface || surface.mode === 'climb' || surface.status !== 'valid' || u === null || !Number.isFinite(u) || !this.fits(surface, u)) return null;
    const point = this.pointOn(surface, u);
    if (point.y - this.appearance.height < readViewport(this.doc).top) return null;
    return { surface, u };
  }

  private standingU(surface: SurfaceSnapshot, preferred = 0.5): number | null {
    const width = surface.b.x - surface.a.x;
    if (surface.mode === 'climb' || surface.status !== 'valid' || Math.abs(surface.a.y - surface.b.y) > 1e-6 || width <= 0) return null;
    const margin = this.appearance.height * 0.26 / width;
    let best: number | null = null;
    for (const range of surface.available) {
      if (range.end - range.start < margin * 2) continue;
      const u = Math.max(range.start + margin, Math.min(range.end - margin, preferred));
      if (best === null || Math.abs(u - preferred) < Math.abs(best - preferred)) best = u;
    }
    return best;
  }

  private climbingU(surface: SurfaceSnapshot, preferred = 0.5): number | null {
    if (surface.mode !== 'climb' || surface.status !== 'valid') return null;
    const length = Math.hypot(surface.b.x - surface.a.x, surface.b.y - surface.a.y);
    if (length < this.appearance.height * 2) return null;
    let best: number | null = null;
    for (const range of surface.available) {
      const mid = (range.start + range.end) / 2;
      const safe = climbInterval(surface, mid, this.appearance.height);
      if (!safe) continue;
      const u = Math.max(safe.start, Math.min(safe.end, preferred));
      if (best === null || Math.abs(u - preferred) < Math.abs(best - preferred)) best = u;
    }
    return best;
  }

  private resolveClimbTarget(target: MoveTarget): { surface: SurfaceSnapshot; u: number } | null {
    if (!this.doc || !this.store || !this.root || !target || typeof target !== 'object') return null;
    if ('nodeType' in target) {
      if (target.ownerDocument !== this.doc || !this.root.contains(target)) return null;
      const candidates = this.store.measureClimbs(target, readViewport(this.doc)).flatMap((surface) => {
        const u = this.climbingU(surface, 0.18);
        return u === null ? [] : [{ surface, u }];
      });
      candidates.sort((a, b) => this.distanceTo(a.surface, a.u) - this.distanceTo(b.surface, b.u));
      return candidates[0] ?? null;
    }
    if ('surfaceId' in target) {
      const surface = this.store.refresh(target.surfaceId, readViewport(this.doc));
      if (!surface || surface.mode !== 'climb' || surface.status !== 'valid') return null;
      const u = target.u ?? this.climbingU(surface, 0.18);
      return u !== null && Number.isFinite(u) && this.fits(surface, u) ? { surface, u } : null;
    }
    return null;
  }

  private distanceTo(surface: SurfaceSnapshot, u: number): number {
    const point = this.pointOn(surface, u);
    return this.body ? Math.hypot(point.x - this.body.position.x, point.y - this.body.position.y) : Infinity;
  }

  private nearestClimb(): { surface: SurfaceSnapshot; u: number } | null {
    let best: { surface: SurfaceSnapshot; u: number } | null = null;
    let distance = this.appearance.height * 8;
    for (const surface of this.store!.snapshots()) {
      const u = this.climbingU(surface, 0.18);
      if (u === null) continue;
      const dx = surface.b.x - surface.a.x, dy = surface.b.y - surface.a.y;
      const origin = this.body!.position;
      const preferred = ((origin.x - surface.a.x - surface.normal!.x * this.appearance.height * 0.26) * dx + (origin.y - surface.a.y - surface.normal!.y * this.appearance.height * 0.26) * dy) / (dx * dx + dy * dy);
      const closest = this.climbingU(surface, preferred)!;
      const d = this.distanceTo(surface, closest);
      if (d < distance) { distance = d; best = { surface, u }; }
    }
    return best;
  }

  private fitsSit(surface: SurfaceSnapshot, u: number, facing: 1 | -1): boolean {
    const x = this.pointOn(surface, u).x;
    const width = surface.b.x - surface.a.x;
    const left = x - this.appearance.height * (facing === 1 ? 0.42 : 0.65);
    const right = x + this.appearance.height * (facing === 1 ? 0.65 : 0.42);
    return surface.available.some((range) => left >= surface.a.x + range.start * width && right <= surface.a.x + range.end * width);
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
    if (surface.mode === 'climb') return Boolean(climbInterval(surface, u, this.appearance.height));
    if (Math.abs(surface.a.y - surface.b.y) > 1e-6) return false;
    const length = surface.b.x - surface.a.x;
    const margin = this.appearance.height * 0.26 / length;
    return length > 0 && surface.available.some((interval) => u - margin >= interval.start - 1e-8 && u + margin <= interval.end + 1e-8);
  }

  private pointOn(surface: SurfaceSnapshot, u: number): Point {
    if (surface.mode === 'climb') return climbRoot(surface, u, this.appearance.height);
    return { x: surface.a.x + (surface.b.x - surface.a.x) * u, y: surface.a.y + (surface.b.y - surface.a.y) * u };
  }

  private anchorTo(surface: SurfaceSnapshot, u: number): void {
    this.previousPhysics = null;
    if (this.recentSurfaces.at(-1) !== surface.id) {
      this.recentSurfaces.push(surface.id);
      if (this.recentSurfaces.length > 8) this.recentSurfaces.shift();
    }
    this.visits.set(surface.id, (this.visits.get(surface.id) ?? 0) + 1);
    if (this.visits.size > 64) this.visits.delete(this.visits.keys().next().value!);
    this.climb = null;
    this.support = { surfaceId: surface.id, sourceRevision: surface.sourceRevision, u };
    this.body = { position: this.pointOn(surface, u), velocity: { x: 0, y: 0 } };
    this.decisionAt = this.simulationTime;
    const element = this.store!.element(surface.id)!;
    this.motionFrame = selectFrame(element);
    this.saveLocalPosition();
    this.emit('surfacechange', { support: { ...this.support } });
  }

  private anchorClimb(surface: SurfaceSnapshot, u: number): void {
    this.previousPhysics = null;
    if (this.support) this.emit('surfacechange', { support: null });
    this.support = null;
    this.climb = { surfaceId: surface.id, sourceRevision: surface.sourceRevision, u, normal: { ...surface.normal! } };
    this.body = { position: climbRoot(surface, u, this.appearance.height), velocity: { x: 0, y: 0 } };
    this.facing = surface.normal!.x < 0 ? 1 : -1;
    this.pose.facingScale = this.facing;
    this.motionFrame = selectFrame(this.store!.element(surface.id)!);
    this.visits.set(surface.id, (this.visits.get(surface.id) ?? 0) + 1);
    if (this.visits.size > 64) this.visits.delete(this.visits.keys().next().value!);
    this.descentDistance = 0;
    this.climbDistance = 0;
    this.climbAttachTime = 0;
    this.setAction('climb');
    if (this.goal) this.setNavigation('moving', 'hands-grabbed');
    this.saveLocalPosition();
  }

  private releaseClimb(): void {
    this.previousPhysics = null;
    this.climb = null;
    this.unknownFrames = 0;
    this.descentDistance = 0;
    this.saveLocalPosition();
  }

  private releaseSupport(): void {
    this.previousPhysics = null;
    if (this.support) this.emit('surfacechange', { support: null });
    this.support = null;
    this.pendingJump = null;
    this.descentDistance = 0;
    this.afterTransition = null;
    this.unknownFrames = 0;
    this.saveLocalPosition();
  }

  private syncPendingContactPosition(): void {
    if (!this.body || !this.localPosition || !this.motionFrame) return;
    const frame = readFrame(this.motionFrame);
    if (frame) this.body.position = toClient(this.localPosition, frame);
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
      if (this.climb && this.body) this.body.velocity = { x: 0, y: 0 };
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
    this.climbFlight = null;
    this.dash = null;
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
    const automatic = this.goal?.automatic === true;
    this.planning = null;
    this.planningAnchor = null;
    this.route = [];
    this.climbFlight = null;
    if (automatic && this.autonomous && status !== 'completed' && ['edge', 'obstructed', 'path-changed', 'unreachable'].includes(reason ?? '')) {
      this.retries++;
      this.retryAt = this.simulationTime + 0.6;
      this.dash = null;
      this.pendingJump = null;
      this.afterTransition = null;
      this.targetId = null;
      this.targetRevision = null;
      if (this.climb && this.body) this.body.velocity = { x: 0, y: 0 };
      if (this.action === 'walk' || this.action === 'run' || this.action === 'sprint') this.walkDuration = this.actionTime;
      this.setNavigation('unreachable', reason ?? 'retry');
      return;
    }
    this.setNavigation(status === 'completed' ? 'arrived' : 'waiting', reason ?? status);
    this.moveAbort?.();
    this.moveAbort = null;
    this.pendingMove?.({ status, ...(reason ? { reason } : {}) });
    this.pendingMove = null;
    this.goal = null;
    this.exploring = false;
    if (!this.pendingAction) {
      this.pendingJump = null;
      this.afterTransition = null;
      this.targetId = null;
      this.targetRevision = null;
      this.dash = null;
      this.resumeMotion = null;
      if (this.action === 'walk' || this.action === 'run' || this.action === 'sprint') this.walkDuration = this.actionTime;
    }
    if (this.climb && this.body) this.body.velocity = { x: 0, y: 0 };
    this.decisionAt = this.simulationTime + 0.8;
    if (automatic && this.autonomous && status === 'completed' && this.doc && this.chooseRandomGoal(readViewport(this.doc))) {
      this.restUntil = status === 'completed' && this.random() < 0.35 ? this.simulationTime + 0.35 + this.random() * 0.65 : 0;
      if (this.restUntil > this.simulationTime) this.setNavigation('resting', 'short-rest');
    } else this.emit('targetchange', { target: null });
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

  private clearIgnored(): void {
    this.ignoredId = null;
    this.ignoredFill = null;
    this.ignoredRevision = null;
    this.ignoredTime = 0;
  }

  private releaseResources(): void {
    this.clearIgnored();
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
