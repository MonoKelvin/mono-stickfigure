import type { Anchor, Body, Point, SurfaceSnapshot } from './scene/types';

export type ActionId = 'idle' | 'jump' | 'fall' | 'land-soft';
export type PauseReason = 'user' | 'document-hidden' | 'offscreen' | 'verification' | 'top-layer' | 'boundary-wait';
export type LifecycleStatus = 'created' | 'starting' | 'running' | 'paused' | 'destroyed';

export interface Appearance {
  height: number;
  color: string;
  lineWidth: number;
  head: 'circle' | 'square';
}

export interface StickFigureOptions {
  root?: Document | Element | ShadowRoot;
  mount?: HTMLElement;
  seed?: number;
  appearance?: Partial<Appearance>;
  performance?: { scanBudgetMs?: number; maxSurfaces?: number; maxDpr?: number };
  boundary?: { wrapX?: boolean; wrapY?: boolean };
  motionPreference?: 'respect' | 'full';
  debug?: boolean;
}

export interface SurfaceTarget {
  surfaceId: string;
  u?: number;
}

export type PlaceTarget = Element | SurfaceTarget;
export interface ActionOptions {
  target?: PlaceTarget;
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

export interface StickFigureSnapshot {
  status: LifecycleStatus;
  pauses: readonly PauseReason[];
  action: ActionId;
  position: Point | null;
  velocity: Point;
  support: Anchor | null;
  surfaces: readonly SurfaceSnapshot[];
  diagnostics: Diagnostics;
}

export interface StickFigureEvents {
  ready: StartResult;
  statechange: LifecycleStatus;
  actionchange: { action: ActionId };
  surfacechange: { support: Anchor | null };
  boundary: { axis: 'x' | 'y' };
  error: { code: string; message: string };
}

export interface StickFigure {
  start(): Promise<StartResult>;
  pause(): void;
  resume(): void;
  destroy(): void;
  place(target: PlaceTarget): Promise<PlaceResult>;
  requestAction(action: ActionId, options?: ActionOptions): Promise<ActionResult>;
  on<K extends keyof StickFigureEvents>(event: K, listener: (payload: StickFigureEvents[K]) => void): () => void;
  getSnapshot(): StickFigureSnapshot;
}

export type { Anchor, Body, Point, SurfaceSnapshot };
