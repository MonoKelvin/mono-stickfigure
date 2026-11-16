import type { Anchor, Body, ClimbContact, Point, SurfaceSnapshot } from './scene/types';

export type ActionId = 'idle' | 'walk' | 'run' | 'sprint' | 'turn' | 'anticipate' | 'brake' | 'wave' | 'crouch' | 'rest' | 'prone' | 'stand-up' | 'jump' | 'run-jump' | 'running-long-jump' | 'fall' | 'land-soft' | 'roll' | 'sit' | 'question' | 'run-in-place' | 'climb';
export type PauseReason = 'user' | 'document-hidden' | 'offscreen' | 'verification' | 'top-layer' | 'boundary-wait';
export type LifecycleStatus = 'created' | 'starting' | 'running' | 'paused' | 'destroyed';

export interface Appearance {
  height: number;
  color: string;
  lineWidth: number;
  head: 'circle' | 'square';
}

export interface Physics {
  /** m/s²，默认 9.8，范围 4–20；内部固定以 100 CSS px/m 换算。 */
  gravity: number;
  jumpHeight: number;
  maxFallSpeed: number;
}

export interface Recognition {
  colorTolerance: number;
}

export interface StickFigureOptions {
  root?: Document | Element | ShadowRoot;
  mount?: HTMLElement;
  seed?: number;
  appearance?: Partial<Appearance>;
  physics?: Partial<Physics>;
  recognition?: Partial<Recognition>;
  autonomous?: boolean;
  performance?: { navigationBudgetMs?: number; scanBudgetMs?: number; maxSurfaces?: number; maxDpr?: number };
  boundary?: { wrapX?: boolean; wrapY?: boolean };
  motionPreference?: 'respect' | 'full';
  debug?: boolean;
}

export interface SurfaceTarget {
  surfaceId: string;
  u?: number;
}

export type PlaceTarget = Element | SurfaceTarget;
export type MoveTarget = PlaceTarget | { position: Point; coordinateSpace?: 'viewport' | 'document' };
export interface MoveOptions {
  pace?: 'walk' | 'run' | 'sprint';
  signal?: AbortSignal;
}
export interface ActionOptions {
  target?: MoveTarget;
  direction?: 1 | -1;
  duration?: number;
  signal?: AbortSignal;
}

export interface StartResult {
  status: 'ready' | 'empty' | 'paused';
  supportedActions: readonly ActionId[];
}

export interface ActionResult {
  status: 'completed' | 'rejected' | 'interrupted';
  reason?: string;
}

export interface PlaceResult {
  status: 'placed' | 'rejected';
  reason?: string;
}

export interface Diagnostics {
  frameMs: number;
  scanMs: number;
  measuredElements: number;
  surfaceCount: number;
  droppedTimeMs: number;
}

export interface NavigationDecision {
  id: number;
  time: number;
  reason: string;
  target: Point | null;
  status: 'waiting' | 'planning' | 'moving' | 'resting' | 'unreachable' | 'arrived';
}

export interface NavigationDiagnostics {
  status: NavigationDecision['status'];
  goalId: number;
  distance: number | null;
  reason: string;
  planningMs: number;
  candidates: number;
  expanded: number;
  checkedEdges: number;
  replans: number;
  history: readonly NavigationDecision[];
}

export interface StickFigureSnapshot {
  status: LifecycleStatus;
  pauses: readonly PauseReason[];
  action: ActionId;
  facing: 1 | -1;
  autonomous: boolean;
  appearance: Readonly<Appearance>;
  physics: Readonly<Physics>;
  recognition: Readonly<Recognition>;
  position: Point | null;
  velocity: Point;
  support: Anchor | null;
  climb: ClimbContact | null;
  navigation: NavigationDiagnostics;
  target: { position: Point; surfaceId?: string; u?: number } | null;
  path: readonly Point[];
  surfaces: readonly SurfaceSnapshot[];
  diagnostics: Diagnostics;
}

export interface StickFigureEvents {
  ready: StartResult;
  statechange: LifecycleStatus;
  actionchange: { action: ActionId };
  surfacechange: { support: Anchor | null };
  navigationchange: NavigationDecision;
  targetchange: { target: Point | null };
  boundary: { axis: 'x' | 'y' };
  error: { code: string; message: string };
}

export interface StickFigure {
  start(): Promise<StartResult>;
  pause(): void;
  resume(): void;
  setAutonomous(enabled: boolean): void;
  destroy(): void;
  place(target: PlaceTarget): Promise<PlaceResult>;
  moveTo(target: MoveTarget, options?: MoveOptions): Promise<ActionResult>;
  requestAction(action: ActionId, options?: ActionOptions): Promise<ActionResult>;
  on<K extends keyof StickFigureEvents>(event: K, listener: (payload: StickFigureEvents[K]) => void): () => void;
  getSnapshot(): StickFigureSnapshot;
}

export type { Anchor, Body, ClimbContact, Point, SurfaceSnapshot };
