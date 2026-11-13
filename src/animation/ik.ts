import type { Point } from '../scene/types';

export function solveTwoBone(origin: Point, target: Point, first: number, second: number, bend: 1 | -1 = 1): { joint: Point; end: Point } {
  const dx = target.x - origin.x;
  const dy = target.y - origin.y;
  const rawDistance = Math.hypot(dx, dy);
  const distance = Math.min(first + second, Math.max(Math.abs(first - second), rawDistance));
  const ux = rawDistance > 1e-10 ? dx / rawDistance : 0;
  const uy = rawDistance > 1e-10 ? dy / rawDistance : 1;
  if (distance < 1e-10) return { joint: { x: origin.x + first * bend, y: origin.y }, end: { ...origin } };
  const along = (first * first - second * second + distance * distance) / (2 * distance);
  const perpendicular = Math.sqrt(Math.max(0, first * first - along * along)) * bend;
  return {
    joint: { x: origin.x + ux * along - uy * perpendicular, y: origin.y + uy * along + ux * perpendicular },
    end: { x: origin.x + ux * distance, y: origin.y + uy * distance },
  };
}
