export interface Point {
  x: number;
  y: number;
}

export interface Interval {
  start: number;
  end: number;
}

export type SurfaceStatus = 'valid' | 'offscreen' | 'unknown' | 'invalid';

export interface SurfaceBounds {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface SurfaceSnapshot {
  id: string;
  sourceId: string;
  sourceRevision: number;
  geometryVersion: number;
  kind: 'border' | 'fill' | 'text';
  a: Point;
  b: Point;
  available: readonly Interval[];
  bounds?: SurfaceBounds;
  status: SurfaceStatus;
  evidence: 'dom-painted-edge' | 'dom-fill' | 'text-metric' | 'text-contour';
}

export interface Anchor {
  surfaceId: string;
  sourceRevision: number;
  u: number;
}

export interface Body {
  position: Point;
  velocity: Point;
}

export interface Landing {
  surfaceId: string;
  u: number;
  impactSpeed: number;
}

export interface StepResult {
  body: Body;
  landing: Landing | null;
}

export interface Viewport {
  left: number;
  top: number;
  right: number;
  bottom: number;
}
