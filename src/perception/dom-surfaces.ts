import { axisScale, parentElement } from '../coordinates/frames';
import type { Interval, Point, SurfaceStatus, Viewport } from '../scene/types';

export interface BorderMeasurement {
  a: Point;
  b: Point;
  available: readonly Interval[];
  status: SurfaceStatus;
  clippedByAncestor: boolean;
}

function alpha(color: string): number {
  if (color === 'transparent') return 0;
  const rgba = color.match(/^rgba\([^,]+,[^,]+,[^,]+,\s*([\d.]+)\)$/);
  if (rgba) return Number(rgba[1]);
  const slash = color.match(/\/\s*([\d.]+)(%)?\s*\)$/);
  return slash ? Number(slash[1]) / (slash[2] ? 100 : 1) : 1;
}

function radius(value: string, width: number, scale: number): number {
  const part = value.split(' ')[0] ?? '0';
  return part.endsWith('%') ? Number.parseFloat(part) * width / 100 : Number.parseFloat(part) * scale;
}

export function measureBorder(element: Element, viewport: Viewport): BorderMeasurement | null {
  const doc = element.ownerDocument;
  const win = doc.defaultView!;
  if (!element.isConnected || element.namespaceURI !== 'http://www.w3.org/1999/xhtml' || element.hasAttribute('data-mono-stickfigure')) return null;
  const style = win.getComputedStyle(element);
  const width = Number.parseFloat(style.borderTopWidth);
  if (style.display === 'none' || style.visibility !== 'visible' || style.borderTopStyle !== 'solid' || !(width > 0) || alpha(style.borderTopColor) < 0.02 || style.writingMode !== 'horizontal-tb') return null;
  let opacity = 1;
  for (let node: Element | null = element; node; node = parentElement(node)) {
    const computed = win.getComputedStyle(node);
    if (computed.display === 'none' || computed.contentVisibility === 'hidden' || node.hasAttribute('data-mono-stickfigure')) return null;
    opacity *= Number(computed.opacity);
    if (opacity < 0.02) return null;
  }
  const rect = element.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0 || element.getClientRects().length !== 1) return null;
  const scale = axisScale(element);
  const a = { x: rect.left, y: rect.top + width * (scale?.y ?? 1) / 2 };
  const b = { x: rect.right, y: a.y };
  if (!scale) return { a, b, available: [], status: 'unknown', clippedByAncestor: false };
  let left = rect.left + radius(style.borderTopLeftRadius, rect.width, scale.x);
  let right = rect.right - radius(style.borderTopRightRadius, rect.width, scale.x);
  let clippedByAncestor = false;
  for (let node: Element | null = element; node; node = parentElement(node)) {
    const s = win.getComputedStyle(node);
    if (s.clipPath !== 'none' || (s.maskImage && s.maskImage !== 'none')) return { a, b, available: [], status: 'unknown', clippedByAncestor: false };
    if (node === element) continue;
    const clipX = /(hidden|clip|auto|scroll)/.test(s.overflowX);
    const clipY = /(hidden|clip|auto|scroll)/.test(s.overflowY);
    if (!clipX && !clipY) continue;
    const parentScale = axisScale(node);
    if (!parentScale) return { a, b, available: [], status: 'unknown', clippedByAncestor: false };
    const box = node.getBoundingClientRect();
    const clipLeft = box.left + node.clientLeft * parentScale.x;
    const clipTop = box.top + node.clientTop * parentScale.y;
    if (clipX) {
      left = Math.max(left, clipLeft);
      right = Math.min(right, clipLeft + node.clientWidth * parentScale.x);
      if (right <= left) clippedByAncestor = true;
    }
    if (clipY && (a.y < clipTop || a.y > clipTop + node.clientHeight * parentScale.y)) clippedByAncestor = true;
  }
  if (clippedByAncestor || a.y < viewport.top || a.y > viewport.bottom || right <= viewport.left || left >= viewport.right) {
    return { a, b, available: [], status: 'offscreen', clippedByAncestor };
  }
  left = Math.max(left, viewport.left);
  right = Math.min(right, viewport.right);
  if (right - left < 2) return { a, b, available: [], status: 'invalid', clippedByAncestor: false };
  const hit = doc.elementFromPoint((left + right) / 2, a.y + Math.min(width * scale.y / 4, 0.5));
  if (hit && hit !== element && !element.contains(hit) && !hit.contains(element)) {
    return { a, b, available: [], status: 'unknown', clippedByAncestor: false };
  }
  return {
    a,
    b,
    available: [{ start: (left - rect.left) / rect.width, end: (right - rect.left) / rect.width }],
    status: 'valid',
    clippedByAncestor: false,
  };
}
