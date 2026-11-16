import { axisScale, parentElement, readRectGeometry, rectLocal, rectPoint } from '../coordinates/frames';
import type { RectGeometry } from '../coordinates/frames';
import type { Interval, Point, SurfaceBounds, SurfaceSnapshot, SurfaceStatus, Viewport } from '../scene/types';

export interface SurfaceMeasurement {
  a: Point;
  b: Point;
  available: readonly Interval[];
  bounds?: SurfaceBounds;
  status: SurfaceStatus;
  clippedByAncestor: boolean;
  kind: SurfaceSnapshot['kind'];
  mode?: SurfaceSnapshot['mode'];
  normal?: Point;
  feature?: string;
  evidence: SurfaceSnapshot['evidence'];
}

type Color = readonly [number, number, number, number];
const colorReaders = new WeakMap<Document, { context: CanvasRenderingContext2D; cache: Map<string, Color> }>();

function color(doc: Document, value: string): Color {
  let reader = colorReaders.get(doc);
  if (!reader) {
    const canvas = doc.createElement('canvas');
    canvas.width = canvas.height = 1;
    reader = { context: canvas.getContext('2d', { willReadFrequently: true })!, cache: new Map() };
    colorReaders.set(doc, reader);
  }
  const cached = reader.cache.get(value);
  if (cached) return cached;
  reader.context.clearRect(0, 0, 1, 1);
  reader.context.fillStyle = value;
  reader.context.fillRect(0, 0, 1, 1);
  const pixel = reader.context.getImageData(0, 0, 1, 1).data;
  const result: Color = [pixel[0]! / 255, pixel[1]! / 255, pixel[2]! / 255, pixel[3]! / 255];
  if (reader.cache.size >= 128) reader.cache.delete(reader.cache.keys().next().value!);
  reader.cache.set(value, result);
  return result;
}

function composite(foreground: Color, background: Color): Color {
  const alpha = foreground[3] + background[3] * (1 - foreground[3]);
  if (!alpha) return [0, 0, 0, 0];
  return [
    (foreground[0] * foreground[3] + background[0] * background[3] * (1 - foreground[3])) / alpha,
    (foreground[1] * foreground[3] + background[1] * background[3] * (1 - foreground[3])) / alpha,
    (foreground[2] * foreground[3] + background[2] * background[3] * (1 - foreground[3])) / alpha,
    alpha,
  ];
}

function lab(value: Color): readonly [number, number, number] {
  const linear = (v: number) => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  const r = linear(value[0]), g = linear(value[1]), b = linear(value[2]);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
}

function difference(painted: Color, backdrop: Color): number {
  const p = lab(painted), q = lab(backdrop);
  return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
}

interface PaintStyle {
  style: CSSStyleDeclaration;
  box: DOMRect;
  scale: Point | null;
  geometry?: RectGeometry | null;
}

export interface SurfaceMeasurementContext {
  visible?: ReturnType<typeof visibleStyle>;
  box?: DOMRect;
  styles?: Map<Element, PaintStyle>;
}

function measuredStyle(element: Element, context: SurfaceMeasurementContext): ReturnType<typeof visibleStyle> {
  if (context.visible === undefined) context.visible = visibleStyle(element);
  return context.visible;
}

function paintAt(doc: Document, point: Point, styles: Map<Element, PaintStyle>, subject?: Element, kind?: SurfaceSnapshot['kind'], borderEdge: 'Top' | 'Bottom' | 'Left' | 'Right' = 'Top'): readonly [Color, Color] | null {
  const hits = doc.elementsFromPoint(point.x, point.y).filter((node) => !node.hasAttribute('data-mono-stickfigure'));
  if (!hits.length || hits.length > 32) return null;
  const nodes = new Map<Element, { order: number; children: Element[] }>();
  const read = (node: Element): PaintStyle => {
    let value = styles.get(node);
    if (!value) {
      const style = doc.defaultView!.getComputedStyle(node), box = node.getBoundingClientRect(), scale = axisScale(node);
      value = { style, box, scale, ...(!scale ? { geometry: readRectGeometry(node, style, box) } : {}) };
      styles.set(node, value);
    }
    return value;
  };
  const add = (node: Element, order: number): void => {
    const known = nodes.get(node);
    if (known) { known.order = Math.min(known.order, order); return; }
    nodes.set(node, { order, children: [] });
    const parent = parentElement(node);
    if (parent) { add(parent, order); nodes.get(parent)!.children.push(node); }
  };
  hits.forEach(add);
  if (subject && !nodes.has(subject)) return null;
  const render = (node: Element): readonly [Color, Color] | null => {
    const measured = read(node);
    const { style, geometry } = measured;
    const scale = measured.scale ?? (geometry ? { x: 1, y: 1 } : null);
    const sample = geometry ? rectLocal(point, geometry) : point;
    const box = geometry ? { left: 0, top: 0, right: geometry.width, bottom: geometry.height } : measured.box;
    if (style.display === 'none' || style.visibility !== 'visible' || Number(style.opacity) === 0) return [[0, 0, 0, 0], [0, 0, 0, 0]];
    if (!scale || style.mixBlendMode !== 'normal' || style.filter !== 'none' || (style.backdropFilter && style.backdropFilter !== 'none') || style.clipPath !== 'none' || (style.maskImage && style.maskImage !== 'none')) return null;
    const inside = sample.x >= box.left && sample.x < box.right && sample.y >= box.top && sample.y < box.bottom;
    if (inside && (style.backgroundImage !== 'none' || style.backgroundClip === 'text' || ['IMG', 'VIDEO', 'CANVAS', 'SVG', 'IFRAME'].includes(node.tagName.toUpperCase()))) return null;
    const widths = [style.borderTopWidth, style.borderRightWidth, style.borderBottomWidth, style.borderLeftWidth].map(Number.parseFloat);
    let left = box.left, right = box.right, top = box.top, bottom = box.bottom;
    if (style.backgroundClip !== 'border-box') {
      left += widths[3]! * scale.x; right -= widths[1]! * scale.x;
      top += widths[0]! * scale.y; bottom -= widths[2]! * scale.y;
      if (style.backgroundClip === 'content-box') {
        left += Number.parseFloat(style.paddingLeft) * scale.x; right -= Number.parseFloat(style.paddingRight) * scale.x;
        top += Number.parseFloat(style.paddingTop) * scale.y; bottom -= Number.parseFloat(style.paddingBottom) * scale.y;
      }
    }
    const background = sample.x >= left && sample.x < right && sample.y >= top && sample.y < bottom || node === doc.documentElement
      ? color(doc, style.backgroundColor) : [0, 0, 0, 0] as Color;
    let painted = background, backdrop = background;
    if (node === subject) {
      const foreground = color(doc, kind === 'fill' ? style.backgroundColor : kind === 'border' ? style.getPropertyValue(`border-${borderEdge.toLowerCase()}-color`) : style.webkitTextFillColor || style.color);
      painted = kind === 'fill' ? foreground : composite(foreground, background);
      if (kind !== 'text') backdrop = [0, 0, 0, 0];
    }
    if (inside && !(node === subject && kind === 'border')) {
      const edge = sample.y < box.top + widths[0]! * scale.y ? 'Top'
        : sample.y >= box.bottom - widths[2]! * scale.y ? 'Bottom'
          : sample.x < box.left + widths[3]! * scale.x ? 'Left'
            : sample.x >= box.right - widths[1]! * scale.x ? 'Right' : null;
      if (edge) {
        const borderStyle = style.getPropertyValue(`border-${edge.toLowerCase()}-style`);
        if (borderStyle !== 'none' && borderStyle !== 'hidden' && borderStyle !== 'solid') return null;
        if (borderStyle === 'solid') {
          const border = color(doc, style.getPropertyValue(`border-${edge.toLowerCase()}-color`));
          painted = composite(border, painted); backdrop = composite(border, backdrop);
        }
      }
    }
    for (const child of nodes.get(node)!.children.sort((a, b) => nodes.get(b)!.order - nodes.get(a)!.order)) {
      const result = render(child);
      if (!result) return null;
      painted = composite(result[0], painted); backdrop = composite(result[1], backdrop);
    }
    const opacity = Number(style.opacity);
    return [[painted[0], painted[1], painted[2], painted[3] * opacity], [backdrop[0], backdrop[1], backdrop[2], backdrop[3] * opacity]];
  };
  const result = render(doc.documentElement);
  if (!result) return null;
  const canvas = color(doc, 'Canvas');
  return [composite(result[0], canvas), composite(result[1], canvas)];
}

export function hasVisibleText(element: Element, style: CSSStyleDeclaration, opacity: number): boolean {
  return color(element.ownerDocument, style.webkitTextFillColor || style.color)[3] * opacity > 0;
}

export function visibleStyle(element: Element): { style: CSSStyleDeclaration; opacity: number } | null {
  if (!element.isConnected || element.namespaceURI !== 'http://www.w3.org/1999/xhtml' || element.hasAttribute('data-mono-stickfigure')) return null;
  const win = element.ownerDocument.defaultView!;
  const style = win.getComputedStyle(element);
  if (style.display === 'none' || style.visibility !== 'visible' || style.writingMode !== 'horizontal-tb') return null;
  let opacity = 1;
  for (let node: Element | null = element; node; node = parentElement(node)) {
    if (node !== element && node.tagName === 'DETAILS' && !node.hasAttribute('open') && !node.querySelector(':scope > summary')?.contains(element)) return null;
    const computed = win.getComputedStyle(node);
    if (computed.display === 'none' || computed.contentVisibility === 'hidden' || node.hasAttribute('data-mono-stickfigure')) return null;
    opacity *= Number(computed.opacity);
    if (!(opacity > 0)) return null;
  }
  return { style, opacity };
}

function topRadii(style: CSSStyleDeclaration, width: number, height: number, sx: number, sy: number, edge: 'Top' | 'Bottom' = 'Top'): { left: number; right: number } {
  const read = (value: string) => {
    const parts = value.split(/\s+/);
    const x = parts[0] ?? '0', y = parts[1] ?? x;
    return { x: x.endsWith('%') ? Number.parseFloat(x) * width / 100 : Number.parseFloat(x) * sx, y: y.endsWith('%') ? Number.parseFloat(y) * height / 100 : Number.parseFloat(y) * sy };
  };
  const tl = read(style.borderTopLeftRadius), tr = read(style.borderTopRightRadius);
  const bl = read(style.borderBottomLeftRadius), br = read(style.borderBottomRightRadius);
  const factor = Math.min(1, width / (tl.x + tr.x || width), width / (bl.x + br.x || width), height / (tl.y + bl.y || height), height / (tr.y + br.y || height));
  return edge === 'Top' ? { left: tl.x * factor, right: tr.x * factor } : { left: bl.x * factor, right: br.x * factor };
}

export function projectSurface(element: Element, a: Point, b: Point, left: number, right: number, viewport: Viewport, kind: SurfaceSnapshot['kind'], evidence: SurfaceSnapshot['evidence'], clipSelf = false, bounds?: SurfaceBounds): SurfaceMeasurement {
  const win = element.ownerDocument.defaultView!;
  const measured = (status: SurfaceStatus, available: readonly Interval[] = [], clippedByAncestor = false): SurfaceMeasurement => ({ a, b, available, status, clippedByAncestor, kind, evidence, ...(bounds ? { bounds } : {}) });
  if (!axisScale(element)) return measured('unknown');
  let clipped = false;
  for (let node: Element | null = element; node; node = parentElement(node)) {
    const style = win.getComputedStyle(node);
    if (style.clipPath !== 'none' || (style.maskImage && style.maskImage !== 'none')) return measured('unknown');
    if (node === element && !clipSelf) continue;
    const clipX = /(hidden|clip|auto|scroll)/.test(style.overflowX);
    const clipY = /(hidden|clip|auto|scroll)/.test(style.overflowY);
    if (!clipX && !clipY) continue;
    const scale = axisScale(node);
    if (!scale) return measured('unknown');
    const box = node.getBoundingClientRect();
    const clipLeft = box.left + node.clientLeft * scale.x;
    const clipTop = box.top + node.clientTop * scale.y;
    const clipRight = clipLeft + node.clientWidth * scale.x;
    const clipBottom = clipTop + node.clientHeight * scale.y;
    if (clipX) {
      left = Math.max(left, clipLeft);
      right = Math.min(right, clipRight);
      if (bounds) bounds = { ...bounds, left: Math.max(bounds.left, clipLeft), right: Math.min(bounds.right, clipRight) };
      if (right <= left) clipped = true;
    }
    if (clipY) {
      if (bounds) bounds = { ...bounds, top: Math.max(bounds.top, clipTop), bottom: Math.min(bounds.bottom, clipBottom) };
      if (a.y < clipTop || a.y > clipBottom) clipped = true;
    }
  }
  if (clipped || a.y < viewport.top || a.y > viewport.bottom || right <= viewport.left || left >= viewport.right) return measured('offscreen', [], clipped);
  left = Math.max(left, viewport.left);
  right = Math.min(right, viewport.right);
  if (right - left < 2) return measured('invalid');
  let ranges = [{ start: left, end: right }];
  const seen = new Set<Element>();
  const samples = Math.min(8, Math.max(3, Math.ceil((right - left) / 64)));
  for (let i = 0; i < samples; i++) {
    const hit = element.ownerDocument.elementFromPoint(left + (right - left) * (i + 0.5) / samples, a.y + 0.5);
    if (!hit || seen.has(hit) || hit === element || element.contains(hit) || hit.contains(element)) continue;
    seen.add(hit);
    const style = win.getComputedStyle(hit);
    if (color(element.ownerDocument, style.backgroundColor)[3] === 0 && style.backgroundImage === 'none' && !['IMG', 'VIDEO', 'CANVAS', 'SVG'].includes(hit.tagName.toUpperCase())) continue;
    const box = hit.getBoundingClientRect();
    ranges = ranges.flatMap((range) => {
      if (box.right <= range.start || box.left >= range.end) return [range];
      const pieces = [];
      if (box.left > range.start) pieces.push({ start: range.start, end: box.left });
      if (box.right < range.end) pieces.push({ start: box.right, end: range.end });
      return pieces;
    });
  }
  const available = ranges.filter((range) => range.end - range.start >= 2).map((range) => ({ start: (range.start - a.x) / (b.x - a.x), end: (range.end - a.x) / (b.x - a.x) }));
  return measured(available.length ? 'valid' : 'invalid', available);
}

function coloredSurface(element: Element, measured: SurfaceMeasurement, tolerance: number, insideY: number, outsideY?: number, borderEdge: 'Top' | 'Bottom' | 'Left' | 'Right' = 'Top', styles = new Map<Element, PaintStyle>()): SurfaceMeasurement {
  if (measured.status !== 'valid') return measured;
  const doc = element.ownerDocument;
  const available: Interval[] = [];
  let unknown = false;
  const width = measured.b.x - measured.a.x;
  for (const range of measured.available) {
    const left = measured.a.x + range.start * width, right = measured.a.x + range.end * width;
    const samples = Math.min(8, Math.max(3, Math.ceil((right - left) / 64)));
    for (let i = 0; i < samples; i++) {
      const x = left + (right - left) * (i + 0.5) / samples;
      const inside = paintAt(doc, { x, y: insideY }, styles, element, measured.kind, borderEdge);
      const outside = outsideY === undefined ? inside : paintAt(doc, { x, y: outsideY }, styles);
      if (!inside || !outside) { unknown = true; continue; }
      if (measured.kind === 'fill' && difference(inside[0], inside[1]) < tolerance) continue;
      if (difference(inside[0], outsideY === undefined ? inside[1] : outside[0]) < tolerance) continue;
      const start = range.start + (range.end - range.start) * i / samples;
      const end = range.start + (range.end - range.start) * (i + 1) / samples;
      const previous = available.at(-1);
      if (previous && Math.abs(previous.end - start) < 1e-7) previous.end = end;
      else available.push({ start, end });
    }
  }
  return { ...measured, available, status: available.length ? 'valid' : unknown ? 'unknown' : 'invalid' };
}

export function measureTextSurface(element: Element, a: Point, b: Point, viewport: Viewport, evidence: 'text-metric' | 'text-contour', tolerance: number): SurfaceMeasurement {
  return coloredSurface(element, projectSurface(element, a, b, a.x, b.x, viewport, 'text', evidence, true), tolerance, a.y + 0.5);
}

export function measureBorder(element: Element, viewport: Viewport, tolerance = 0.01, context: SurfaceMeasurementContext = {}): SurfaceMeasurement | null {
  const visible = measuredStyle(element, context);
  if (!visible) return null;
  const { style, opacity } = visible;
  if (!(opacity > 0)) return null;
  const candidates = (['Top', 'Bottom'] as const).flatMap(edge => {
    const prefix = `border-${edge.toLowerCase()}`;
    const width = Number.parseFloat(style.getPropertyValue(`${prefix}-width`));
    return style.getPropertyValue(`${prefix}-style`) === 'solid' && width > 0 && color(element.ownerDocument, style.getPropertyValue(`${prefix}-color`))[3] ? [{ edge, width }] : [];
  });
  if (!candidates.length) return null;
  const rect = context.box ??= element.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0 || element.getClientRects().length !== 1) return null;
  const scale = axisScale(element);
  let fallback: SurfaceMeasurement | null = null;
  for (const { edge, width } of candidates) {
    const radii = topRadii(style, rect.width, rect.height, scale?.x ?? 1, scale?.y ?? 1, edge);
    const y = edge === 'Top' ? rect.top + width * (scale?.y ?? 1) / 2 : rect.bottom - width * (scale?.y ?? 1) / 2;
    const a = { x: rect.left, y }, b = { x: rect.right, y };
    const outside = edge === 'Top' ? rect.top - 0.5 : rect.bottom + 0.5;
    const measured = coloredSurface(element, projectSurface(element, a, b, rect.left + radii.left, rect.right - radii.right, viewport, 'border', 'dom-painted-edge'), tolerance, y, outside, edge, context.styles ??= new Map());
    if (measured.status === 'valid') return measured;
    fallback ??= measured;
  }
  return fallback;
}

function edgeRadii(style: CSSStyleDeclaration, width: number, height: number, edge: 'Top' | 'Bottom' | 'Left' | 'Right'): { start: number; end: number } {
  const read = (value: string) => {
    const parts = value.split(/\s+/), x = parts[0] ?? '0', y = parts[1] ?? x;
    return { x: Number.parseFloat(x) * (x.endsWith('%') ? width / 100 : 1), y: Number.parseFloat(y) * (y.endsWith('%') ? height / 100 : 1) };
  };
  const tl = read(style.borderTopLeftRadius), tr = read(style.borderTopRightRadius), bl = read(style.borderBottomLeftRadius), br = read(style.borderBottomRightRadius);
  const factor = Math.min(1, width / (tl.x + tr.x || width), width / (bl.x + br.x || width), height / (tl.y + bl.y || height), height / (tr.y + br.y || height));
  const values = edge === 'Top' ? [tl.x, tr.x] : edge === 'Bottom' ? [bl.x, br.x] : edge === 'Left' ? [tl.y, bl.y] : [tr.y, br.y];
  return { start: values[0]! * factor, end: values[1]! * factor };
}

function clippedLine(a: Point, b: Point, range: Interval, left: number, top: number, right: number, bottom: number): Interval | null {
  let start = range.start, end = range.end;
  for (const [origin, delta, low, high] of [[a.x, b.x - a.x, left, right], [a.y, b.y - a.y, top, bottom]]) {
    if (Math.abs(delta!) < 1e-9) {
      if (origin! < low! || origin! > high!) return null;
    } else {
      const first = (low! - origin!) / delta!, second = (high! - origin!) / delta!;
      start = Math.max(start, Math.min(first, second)); end = Math.min(end, Math.max(first, second));
      if (end <= start) return null;
    }
  }
  return { start, end };
}

export function measureClimbEdges(element: Element, viewport: Viewport, tolerance = 0.01, context: SurfaceMeasurementContext = {}): SurfaceMeasurement[] {
  const visible = measuredStyle(element, context);
  if (!visible) return [];
  const { style } = visible;
  const box = context.box ??= element.getBoundingClientRect();
  if (box.width <= 0 || box.height <= 0 || element.getClientRects().length !== 1) return [];
  const doc = element.ownerDocument;
  const borders = (['Top', 'Bottom', 'Left', 'Right'] as const).flatMap(edge => {
    const prefix = `border-${edge.toLowerCase()}`, width = Number.parseFloat(style.getPropertyValue(`${prefix}-width`));
    return style.getPropertyValue(`${prefix}-style`) === 'solid' && width > 0 && color(doc, style.getPropertyValue(`${prefix}-color`))[3] > 0 ? [{ edge, width }] : [];
  });
  const canFill = element.tagName !== 'HTML' && element.tagName !== 'BODY' && style.backgroundImage === 'none' && style.backgroundClip !== 'text' && style.mixBlendMode === 'normal' && color(doc, style.backgroundColor)[3] > 0;
  if (!borders.length && !canFill) return [];
  const geometry = readRectGeometry(element, style, box);
  if (!geometry) {
    const features = [...borders.map(({ edge }) => ({ feature: `border-${edge.toLowerCase()}`, kind: 'border' as const })), ...(canFill ? [{ feature: 'fill-left', kind: 'fill' as const }, { feature: 'fill-right', kind: 'fill' as const }] : [])];
    return features.map(({ feature, kind }) => ({ feature, kind, mode: 'climb', a: { x: box.left, y: box.top }, b: { x: box.left, y: box.bottom }, normal: { x: -1, y: 0 }, available: [], status: 'unknown', clippedByAncestor: false, evidence: kind === 'fill' ? 'dom-fill' : 'dom-painted-edge' }));
  }
  const styles = context.styles ??= new Map<Element, PaintStyle>();
  styles.set(element, { style, box, scale: axisScale(element), geometry });
  const measurements: SurfaceMeasurement[] = [];
  const clipBoxes: { left: number; top: number; right: number; bottom: number }[] = [];
  let uncertain = false;
  for (let node: Element | null = element; node; node = parentElement(node)) {
    const computed = node === element ? style : doc.defaultView!.getComputedStyle(node);
    if (computed.clipPath !== 'none' || (computed.maskImage && computed.maskImage !== 'none') || computed.filter !== 'none' || computed.mixBlendMode !== 'normal' || (computed.backdropFilter && computed.backdropFilter !== 'none')) uncertain = true;
    if (node === element) continue;
    const clipX = /(hidden|clip|auto|scroll)/.test(computed.overflowX), clipY = /(hidden|clip|auto|scroll)/.test(computed.overflowY);
    if (!clipX && !clipY) continue;
    const scale = axisScale(node);
    if (!scale) { uncertain = true; continue; }
    const rect = node.getBoundingClientRect(), left = rect.left + node.clientLeft * scale.x, top = rect.top + node.clientTop * scale.y;
    clipBoxes.push({ left: clipX ? left : -Infinity, right: clipX ? left + node.clientWidth * scale.x : Infinity, top: clipY ? top : -Infinity, bottom: clipY ? top + node.clientHeight * scale.y : Infinity });
  }
  const add = (kind: 'border' | 'fill', edge: 'Top' | 'Bottom' | 'Left' | 'Right', left: number, top: number, right: number, bottom: number, borderWidth = 0): void => {
    const vertical = edge === 'Left' || edge === 'Right';
    const localA = { x: edge === 'Right' ? right : left, y: edge === 'Bottom' ? bottom : top };
    const localB = vertical ? { x: localA.x, y: bottom } : { x: right, y: localA.y };
    let a = rectPoint(localA, geometry), b = rectPoint(localB, geometry);
    const delta = { x: b.x - a.x, y: b.y - a.y }, length = Math.hypot(delta.x, delta.y);
    // computed matrix 的舍入不能把恰好 80° 的边变成可攀爬面。
    if (length < 24 || Math.atan2(Math.abs(delta.y), Math.abs(delta.x)) * 180 / Math.PI <= 80.0001) return;
    const outward = edge === 'Left' ? { x: -geometry.y.y, y: geometry.y.x } : edge === 'Right' ? { x: geometry.y.y, y: -geometry.y.x } : edge === 'Top' ? { x: geometry.x.y, y: -geometry.x.x } : { x: -geometry.x.y, y: geometry.x.x };
    const magnitude = Math.hypot(outward.x, outward.y), normal = { x: outward.x / magnitude, y: outward.y / magnitude };
    const radii = edgeRadii(style, geometry.width, geometry.height, edge), localLength = vertical ? bottom - top : right - left;
    let range: Interval | null = { start: Math.min(1, radii.start / localLength), end: Math.max(0, 1 - radii.end / localLength) };
    if (a.y > b.y) { [a, b] = [b, a]; range = { start: 1 - range.end, end: 1 - range.start }; }
    const feature = `${kind}-${edge.toLowerCase()}`;
    const base: SurfaceMeasurement = { feature, mode: 'climb', kind, normal, a, b, available: [], status: 'invalid', clippedByAncestor: false, evidence: kind === 'fill' ? 'dom-fill' : 'dom-painted-edge' };
    if (uncertain) { measurements.push({ ...base, status: 'unknown' }); return; }
    for (const clip of clipBoxes) {
      range = range && clippedLine(a, b, range, clip.left, clip.top, clip.right, clip.bottom);
      if (!range) { measurements.push({ ...base, status: 'offscreen', clippedByAncestor: true }); return; }
    }
    range = clippedLine(a, b, range, viewport.left, viewport.top, viewport.right - 0.001, viewport.bottom - 0.001);
    if (!range) { measurements.push({ ...base, status: 'offscreen' }); return; }
    const perpendicularScale = Math.abs(geometry.x.x * geometry.y.y - geometry.x.y * geometry.y.x) / magnitude;
    const outsideOffset = kind === 'border' ? borderWidth * perpendicularScale / 2 + 0.5 : 0.5;
    const insideOffset = kind === 'border' ? 0 : -0.5;
    let ranges: Interval[] = [range];
    const samples = Math.min(8, Math.max(3, Math.ceil(length * (range.end - range.start) / 64)));
    const blocked = new Set<Element>();
    for (let i = 0; i < samples; i++) {
      const u = range.start + (range.end - range.start) * (i + 0.5) / samples;
      const point = { x: a.x + (b.x - a.x) * u + normal.x * insideOffset, y: a.y + (b.y - a.y) * u + normal.y * insideOffset };
      const hit = doc.elementFromPoint(point.x, point.y);
      if (!hit || blocked.has(hit) || hit === element || element.contains(hit) || hit.contains(element) || hit.hasAttribute('data-mono-stickfigure')) continue;
      const hitStyle = doc.defaultView!.getComputedStyle(hit);
      if (Number(hitStyle.opacity) === 0 || (color(doc, hitStyle.backgroundColor)[3] === 0 && hitStyle.backgroundImage === 'none' && !['IMG', 'VIDEO', 'CANVAS', 'SVG', 'IFRAME'].includes(hit.tagName.toUpperCase()))) continue;
      blocked.add(hit);
      const rect = hit.getBoundingClientRect(), overlap = clippedLine(a, b, range, rect.left, rect.top, rect.right, rect.bottom);
      if (!overlap) continue;
      ranges = ranges.flatMap(current => current.end <= overlap.start || current.start >= overlap.end ? [current] : [{ start: current.start, end: Math.min(current.end, overlap.start) }, { start: Math.max(current.start, overlap.end), end: current.end }].filter(piece => piece.end > piece.start));
    }
    const available: Interval[] = [];
    let unknown = false;
    for (const current of ranges) {
      const count = Math.min(8, Math.max(3, Math.ceil(length * (current.end - current.start) / 64)));
      for (let i = 0; i < count; i++) {
        const u = current.start + (current.end - current.start) * (i + 0.5) / count;
        const point = { x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u };
        const inside = paintAt(doc, { x: point.x + normal.x * insideOffset, y: point.y + normal.y * insideOffset }, styles, element, kind, edge);
        const outside = paintAt(doc, { x: point.x + normal.x * outsideOffset, y: point.y + normal.y * outsideOffset }, styles);
        if (!inside || !outside) { unknown = true; continue; }
        if ((kind === 'fill' && difference(inside[0], inside[1]) < tolerance) || difference(inside[0], outside[0]) < tolerance) continue;
        const start = current.start + (current.end - current.start) * i / count, end = current.start + (current.end - current.start) * (i + 1) / count;
        const previous = available.at(-1);
        if (previous && Math.abs(previous.end - start) < 1e-7) previous.end = end;
        else available.push({ start, end });
      }
    }
    const usable = available.filter(part => (part.end - part.start) * length >= 24);
    measurements.push({ ...base, available: usable, status: usable.length ? 'valid' : unknown ? 'unknown' : 'invalid' });
  };
  for (const { edge, width } of borders) {
    const left = edge === 'Left' ? width / 2 : 0, right = edge === 'Right' ? geometry.width - width / 2 : geometry.width;
    const top = edge === 'Top' ? width / 2 : 0, bottom = edge === 'Bottom' ? geometry.height - width / 2 : geometry.height;
    add('border', edge, left, top, right, bottom, width);
  }
  if (canFill && axisScale(element)) {
    let left = 0, right = geometry.width, top = 0, bottom = geometry.height;
    if (style.backgroundClip !== 'border-box') {
      left += Number.parseFloat(style.borderLeftWidth); right -= Number.parseFloat(style.borderRightWidth);
      top += Number.parseFloat(style.borderTopWidth); bottom -= Number.parseFloat(style.borderBottomWidth);
      if (style.backgroundClip === 'content-box') {
        left += Number.parseFloat(style.paddingLeft); right -= Number.parseFloat(style.paddingRight);
        top += Number.parseFloat(style.paddingTop); bottom -= Number.parseFloat(style.paddingBottom);
      }
    }
    if (right > left && bottom > top) { add('fill', 'Left', left, top, right, bottom); add('fill', 'Right', left, top, right, bottom); }
  }
  return measurements;
}

export function measureFill(element: Element, viewport: Viewport, tolerance: number, context: SurfaceMeasurementContext = {}): SurfaceMeasurement | null {
  if (element.tagName === 'HTML' || element.tagName === 'BODY') return null;
  const visible = measuredStyle(element, context);
  if (!visible) return null;
  const { style } = visible;
  if (style.backgroundImage !== 'none' || style.mixBlendMode !== 'normal' || style.backgroundClip === 'text') return null;
  const foreground = color(element.ownerDocument, style.backgroundColor);
  if (!foreground[3]) return null;
  const rect = context.box ??= element.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0 || element.getClientRects().length !== 1) return null;
  const scale = axisScale(element);
  const sx = scale?.x ?? 1, sy = scale?.y ?? 1;
  const radii = topRadii(style, rect.width, rect.height, sx, sy);
  let left = rect.left, right = rect.right, top = rect.top, bottom = rect.bottom;
  if (style.backgroundClip !== 'border-box') {
    left += Number.parseFloat(style.borderLeftWidth) * sx;
    right -= Number.parseFloat(style.borderRightWidth) * sx;
    top += Number.parseFloat(style.borderTopWidth) * sy;
    bottom -= Number.parseFloat(style.borderBottomWidth) * sy;
    if (style.backgroundClip === 'content-box') {
      left += Number.parseFloat(style.paddingLeft) * sx;
      right -= Number.parseFloat(style.paddingRight) * sx;
      top += Number.parseFloat(style.paddingTop) * sy;
      bottom -= Number.parseFloat(style.paddingBottom) * sy;
    }
  }
  const a = { x: left, y: top }, b = { x: right, y: top };
  const solid = { left: Math.max(left, rect.left + radii.left), right: Math.min(right, rect.right - radii.right), top, bottom };
  return coloredSurface(element, projectSurface(element, a, b, solid.left, solid.right, viewport, 'fill', 'dom-fill', false, solid), tolerance, Math.min(bottom - 0.01, top + 0.5), top - 0.5, 'Top', context.styles ??= new Map());
}
