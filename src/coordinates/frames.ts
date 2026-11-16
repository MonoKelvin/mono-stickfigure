import type { Point, Viewport } from '../scene/types';

export interface FrameTransform {
  offset: Point;
  scale: Point;
}

export type MotionFrame =
  | { kind: 'viewport'; document: Document }
  | { kind: 'document'; document: Document }
  | { kind: 'scroll'; document: Document; element: Element };

export function parentElement(element: Element): Element | null {
  if (element.assignedSlot) return element.assignedSlot;
  if (element.parentElement) return element.parentElement;
  const root = element.getRootNode();
  return root.nodeType === 11 && 'host' in root ? (root as ShadowRoot).host : null;
}

export function readViewport(doc: Document): Viewport {
  const win = doc.defaultView!;
  const visual = win.visualViewport;
  const left = visual?.offsetLeft ?? 0;
  const top = visual?.offsetTop ?? 0;
  return {
    left,
    top,
    right: left + (visual?.width ?? doc.documentElement.clientWidth),
    bottom: top + (visual?.height ?? doc.documentElement.clientHeight),
  };
}

export function axisScale(element: Element): Point | null {
  const win = element.ownerDocument.defaultView!;
  let x = 1;
  let y = 1;
  for (let node: Element | null = element; node; node = parentElement(node)) {
    const style = win.getComputedStyle(node);
    if (style.perspective !== 'none' || (style.zoom && Number(style.zoom) !== 1)) return null;
    if (style.rotate && style.rotate !== 'none' && style.rotate !== '0deg') return null;
    if (style.transform !== 'none') {
      const matrix = new DOMMatrixReadOnly(style.transform);
      if (!matrix.is2D || Math.abs(matrix.b) > 1e-7 || Math.abs(matrix.c) > 1e-7 || matrix.a <= 0 || matrix.d <= 0) return null;
      x *= matrix.a;
      y *= matrix.d;
    }
    if (style.scale && style.scale !== 'none') {
      const values = style.scale.split(/\s+/).map(Number);
      const sx = values[0] ?? 1;
      const sy = values[1] ?? sx;
      if (!(sx > 0 && sy > 0) || values.length > 2) return null;
      x *= sx;
      y *= sy;
    }
  }
  return { x, y };
}

export interface RectGeometry {
  width: number;
  height: number;
  x: Point;
  y: Point;
  origin: Point;
}

export function readRectGeometry(element: Element, style = element.ownerDocument.defaultView!.getComputedStyle(element), box = element.getBoundingClientRect()): RectGeometry | null {
  if (element.namespaceURI !== 'http://www.w3.org/1999/xhtml' || element.getClientRects().length !== 1 || style.perspective !== 'none' || (style.zoom && Number(style.zoom) !== 1)) return null;
  const parent = parentElement(element);
  const inherited = parent ? axisScale(parent) : { x: 1, y: 1 };
  if (!inherited) return null;
  const matrix = new DOMMatrixReadOnly(style.transform === 'none' ? undefined : style.transform);
  if (!matrix.is2D || matrix.a * matrix.d - matrix.b * matrix.c <= 0 || Math.abs(matrix.a * matrix.c + matrix.b * matrix.d) > 1e-7) return null;
  let angle = 0;
  if (style.rotate && style.rotate !== 'none') {
    const match = style.rotate.match(/^(?:z\s+)?([-+\d.e]+)(deg|rad|turn|grad)$/);
    if (!match) return null;
    angle = Number(match[1]) * (match[2] === 'rad' ? 1 : match[2] === 'turn' ? Math.PI * 2 : match[2] === 'grad' ? Math.PI / 200 : Math.PI / 180);
  }
  const scales = style.scale && style.scale !== 'none' ? style.scale.split(/\s+/).map(Number) : [1];
  const sx = scales[0]!, sy = scales[1] ?? sx;
  if (!(sx > 0 && sy > 0) || scales.length > 2 || (style.translate && style.translate !== 'none' && style.translate.split(/\s+/).length > 2)) return null;
  const cosine = Math.cos(angle), sine = Math.sin(angle);
  const x = { x: (cosine * sx * matrix.a - sine * sy * matrix.b) * inherited.x, y: (sine * sx * matrix.a + cosine * sy * matrix.b) * inherited.y };
  const y = { x: (cosine * sx * matrix.c - sine * sy * matrix.d) * inherited.x, y: (sine * sx * matrix.c + cosine * sy * matrix.d) * inherited.y };
  const extra = (horizontal: boolean) => horizontal
    ? Number.parseFloat(style.paddingLeft) + Number.parseFloat(style.paddingRight) + Number.parseFloat(style.borderLeftWidth) + Number.parseFloat(style.borderRightWidth)
    : Number.parseFloat(style.paddingTop) + Number.parseFloat(style.paddingBottom) + Number.parseFloat(style.borderTopWidth) + Number.parseFloat(style.borderBottomWidth);
  const measuredWidth = Number.parseFloat(style.width), measuredHeight = Number.parseFloat(style.height);
  const width = Number.isFinite(measuredWidth) ? measuredWidth + (style.boxSizing === 'border-box' ? 0 : extra(true)) : (element as HTMLElement).offsetWidth;
  const height = Number.isFinite(measuredHeight) ? measuredHeight + (style.boxSizing === 'border-box' ? 0 : extra(false)) : (element as HTMLElement).offsetHeight;
  if (!(width > 0 && height > 0) || ![x.x, x.y, y.x, y.y, width, height].every(Number.isFinite)) return null;
  const minX = Math.min(0, x.x * width, y.x * height, x.x * width + y.x * height);
  const minY = Math.min(0, x.y * width, y.y * height, x.y * width + y.y * height);
  const expectedWidth = Math.abs(x.x * width) + Math.abs(y.x * height);
  const expectedHeight = Math.abs(x.y * width) + Math.abs(y.y * height);
  if (Math.abs(expectedWidth - box.width) > 0.75 || Math.abs(expectedHeight - box.height) > 0.75) return null;
  return { width, height, x, y, origin: { x: box.left - minX, y: box.top - minY } };
}

export function rectPoint(point: Point, geometry: RectGeometry): Point {
  return { x: geometry.origin.x + point.x * geometry.x.x + point.y * geometry.y.x, y: geometry.origin.y + point.x * geometry.x.y + point.y * geometry.y.y };
}

export function rectLocal(point: Point, geometry: RectGeometry): Point {
  const dx = point.x - geometry.origin.x, dy = point.y - geometry.origin.y;
  const determinant = geometry.x.x * geometry.y.y - geometry.x.y * geometry.y.x;
  return { x: (dx * geometry.y.y - dy * geometry.y.x) / determinant, y: (dy * geometry.x.x - dx * geometry.x.y) / determinant };
}

export function selectFrame(element: Element): MotionFrame {
  const doc = element.ownerDocument;
  const win = doc.defaultView!;
  for (let node: Element | null = element; node; node = parentElement(node)) {
    const style = win.getComputedStyle(node);
    if (style.position === 'fixed') {
      let transformed = false;
      for (let parent = parentElement(node); parent; parent = parentElement(parent)) {
        const s = win.getComputedStyle(parent);
        if (s.transform !== 'none' || s.perspective !== 'none' || s.filter !== 'none' || s.contain.includes('paint')) transformed = true;
      }
      if (!transformed) return { kind: 'viewport', document: doc };
    }
    if (node !== element && node !== doc.documentElement && node !== doc.body && /(auto|scroll|hidden)/.test(`${style.overflowX} ${style.overflowY}`)) {
      return { kind: 'scroll', document: doc, element: node };
    }
  }
  return { kind: 'document', document: doc };
}

export function readFrame(frame: MotionFrame): FrameTransform | null {
  if (frame.kind === 'viewport') return { offset: { x: 0, y: 0 }, scale: { x: 1, y: 1 } };
  if (frame.kind === 'document') {
    const win = frame.document.defaultView!;
    return { offset: { x: -win.scrollX, y: -win.scrollY }, scale: { x: 1, y: 1 } };
  }
  if (!frame.element.isConnected) return null;
  const scale = axisScale(frame.element);
  if (!scale) return null;
  const rect = frame.element.getBoundingClientRect();
  return {
    offset: {
      x: rect.left + (frame.element.clientLeft - frame.element.scrollLeft) * scale.x,
      y: rect.top + (frame.element.clientTop - frame.element.scrollTop) * scale.y,
    },
    scale,
  };
}

export function toClient(point: Point, frame: FrameTransform): Point {
  return { x: frame.offset.x + point.x * frame.scale.x, y: frame.offset.y + point.y * frame.scale.y };
}

export function fromClient(point: Point, frame: FrameTransform): Point {
  return { x: (point.x - frame.offset.x) / frame.scale.x, y: (point.y - frame.offset.y) / frame.scale.y };
}

export function isViewportMount(mount: HTMLElement): boolean {
  const win = mount.ownerDocument.defaultView!;
  for (let node: Element | null = mount; node; node = parentElement(node)) {
    const style = win.getComputedStyle(node);
    if (style.transform !== 'none' || style.perspective !== 'none' || style.filter !== 'none' || style.contain !== 'none' || (style.translate && style.translate !== 'none') || (style.scale && style.scale !== 'none') || (style.rotate && style.rotate !== 'none')) return false;
  }
  return true;
}
