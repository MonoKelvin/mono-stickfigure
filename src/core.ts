import { version } from '../package.json';
import { StickFigureController } from './runtime/controller';
import type { StickFigure, StickFigureOptions } from './types';

export const VERSION: string = version;

export function createStickFigure(options: StickFigureOptions = {}): StickFigure {
  return new StickFigureController(options);
}

export type { ActionId, ActionOptions, ActionResult, Appearance, Diagnostics, NavigationDecision, NavigationDiagnostics, LifecycleStatus, MoveOptions, MoveTarget, PauseReason, Physics, Recognition, PlaceResult, PlaceTarget, StartResult, StickFigure, StickFigureEvents, StickFigureOptions, StickFigureSnapshot, SurfaceTarget } from './types';
export type { Anchor, Body, ClimbContact, Interval, Point, SurfaceBounds, SurfaceSnapshot, SurfaceStatus } from './scene/types';
