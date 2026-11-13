import { StickFigureController } from './runtime/controller';
import type { StickFigure, StickFigureOptions } from './types';

export function createStickFigure(options: StickFigureOptions = {}): StickFigure {
  return new StickFigureController(options);
}

export type { ActionId, ActionOptions, ActionResult, Appearance, Diagnostics, LifecycleStatus, PauseReason, PlaceResult, PlaceTarget, StartResult, StickFigure, StickFigureEvents, StickFigureOptions, StickFigureSnapshot, SurfaceTarget } from './types';
export type { Anchor, Body, Interval, Point, SurfaceSnapshot, SurfaceStatus } from './scene/types';
