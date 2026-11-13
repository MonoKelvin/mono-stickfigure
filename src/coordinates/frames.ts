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
