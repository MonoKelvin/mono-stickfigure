import { StickFigureController } from './runtime/controller';
import type { StickFigure, StickFigureOptions } from './types';

export function createStickFigure(options: StickFigureOptions = {}): StickFigure {
  return new StickFigureController(options);
}

export type { ActionId, ActionOptions, ActionResult, Appearance, Diagnostics, LifecycleStatus, MoveOptions, MoveTarget, PauseReason, Physics, Recognition, PlaceResult, PlaceTarget, StartResult, StickFigure, StickFigureEvents, StickFigureOptions, StickFigureSnapshot, SurfaceTarget } from './types';
export type { Anchor, Body, Interval, Point, SurfaceBounds, SurfaceSnapshot, SurfaceStatus } from './scene/types';
