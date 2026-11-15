import { axisScale } from '../coordinates/frames';
import { hasVisibleText, measureTextSurface, visibleStyle } from './dom-surfaces';
import type { SurfaceMeasurement } from './dom-surfaces';
import type { Viewport } from '../scene/types';

export interface TextPart {
  start: number;
  end: number;
  contour: boolean;
}

export interface TextMeasurement extends SurfaceMeasurement {
  feature: string;
}

interface TextState {
  source: string;
  font: string;
  revision: number;
  parts: readonly TextPart[];
}

interface Contour {
  left: number;
  right: number;
  top: number;
}

export class TextMeasurer {
  private readonly canvas: HTMLCanvasElement;
  private readonly context: CanvasRenderingContext2D;
  private readonly states = new WeakMap<Text, TextState>();
  private readonly contours = new Map<string, readonly Contour[]>();
  private readonly words = new Intl.Segmenter(undefined, { granularity: 'word' });
  private readonly graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  private fontEpoch = 0;

  constructor(doc: Document, private readonly colorTolerance = 0.01) {
    this.canvas = doc.createElement('canvas');
    this.context = this.canvas.getContext('2d', { willReadFrequently: true })!;
  }

  invalidateFonts(): void {
    this.fontEpoch++;
    this.contours.clear();
  }

  parts(node: Text): readonly TextPart[] {
    const element = node.parentElement;
    if (!element || element.closest('script, style, noscript, template, input, textarea, select, [contenteditable]:not([contenteditable="false"]), [data-mono-stickfigure]')) return [];
    const style = element.ownerDocument.defaultView!.getComputedStyle(element);
    const contour = Number.parseFloat(style.fontSize) >= 48 && style.direction === 'ltr';
    const font = this.fontKey(style);
    const source = node.data;
    const old = this.states.get(node);
    if (old?.source === source && old.font === font) return old.parts;
    const parts: TextPart[] = [];
    const segments = (contour ? this.graphemes : this.words).segment(node.data);
    for (const part of segments) {
      if (!/[\p{L}\p{N}]/u.test(part.segment)) continue;
      parts.push({ start: part.index, end: part.index + part.segment.length, contour });
      if (parts.length >= 1024) break;
    }
    this.states.set(node, { source, font, revision: (old?.revision ?? 0) + 1, parts });
    return parts;
  }

  revision(node: Text): number {
    this.parts(node);
    return this.states.get(node)?.revision ?? 1;
  }

  measure(node: Text, part: TextPart, viewport: Viewport): readonly TextMeasurement[] {
    const element = node.parentElement;
    if (!element || !node.isConnected || part.end > node.length) return [];
    const visible = visibleStyle(element);
    if (!visible || !hasVisibleText(element, visible.style, visible.opacity)) return [];
    const style = visible.style;
    const range = element.ownerDocument.createRange();
    range.setStart(node, part.start);
    range.setEnd(node, part.end);
    const rects = [...range.getClientRects()].filter((rect) => rect.width > 0 && rect.height > 0);
    if (!rects.length) return [];
    let text = node.data.slice(part.start, part.end);
    if (style.textTransform === 'uppercase') text = text.toLocaleUpperCase();
    else if (style.textTransform === 'lowercase') text = text.toLocaleLowerCase();
    this.configure(style);
    const metrics = this.context.measureText(text);
    const scale = axisScale(element);
    const sx = scale?.x ?? 1, sy = scale?.y ?? 1;
    const fontAscent = metrics.fontBoundingBoxAscent;
    const fontDescent = metrics.fontBoundingBoxDescent;
    const surfaces: TextMeasurement[] = [];
    for (let line = 0; line < rects.length; line++) {
      const rect = rects[line]!;
      const baseline = rect.top + (rect.height - (fontAscent + fontDescent) * sy) / 2 + fontAscent * sy;
      const top = baseline - metrics.actualBoundingBoxAscent * sy;
      if (part.contour && rects.length === 1) {
        const shapes = this.roof(text, style, metrics);
        for (let i = 0; i < shapes.length; i++) {
          const shape = shapes[i]!;
          const left = rect.left - metrics.actualBoundingBoxLeft * sx + shape.left * sx;
          const right = rect.left - metrics.actualBoundingBoxLeft * sx + shape.right * sx;
          const y = top + shape.top * sy;
          surfaces.push({ ...measureTextSurface(element, { x: left, y }, { x: right, y }, viewport, 'text-contour', this.colorTolerance), feature: `${part.start}:${part.end}:${line}:${i}` });
        }
      } else {
        const left = rect.left - (rects.length === 1 ? metrics.actualBoundingBoxLeft * sx : 0);
        const width = rects.length === 1 ? (metrics.actualBoundingBoxLeft + metrics.actualBoundingBoxRight) * sx : rect.width;
        if (width < 2) continue;
        surfaces.push({ ...measureTextSurface(element, { x: left, y: top }, { x: left + width, y: top }, viewport, 'text-metric', this.colorTolerance), feature: `${part.start}:${part.end}:${line}:metric` });
      }
    }
    return surfaces;
  }

  private fontKey(style: CSSStyleDeclaration): string {
    return `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}|${style.letterSpacing}|${style.fontKerning}|${style.textTransform}`;
  }

  private configure(style: CSSStyleDeclaration): void {
    this.context.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
    this.context.textBaseline = 'alphabetic';
    this.context.textAlign = 'left';
    this.context.direction = style.direction === 'rtl' ? 'rtl' : 'ltr';
    this.context.letterSpacing = style.letterSpacing === 'normal' ? '0px' : style.letterSpacing;
    this.context.fontKerning = style.fontKerning as CanvasFontKerning;
  }

  private roof(text: string, style: CSSStyleDeclaration, metrics: TextMetrics): readonly Contour[] {
    const key = `${this.fontEpoch}:${this.fontKey(style)}:${text}`;
    const cached = this.contours.get(key);
    if (cached) return cached;
    const width = metrics.actualBoundingBoxLeft + metrics.actualBoundingBoxRight;
    const height = metrics.actualBoundingBoxAscent + metrics.actualBoundingBoxDescent;
    if (width < 2 || height < 2) return [];
    const padding = 3;
    const resolution = Math.min(1, 192 / Math.max(width, height));
    this.canvas.width = Math.max(1, Math.ceil((width + padding * 2) * resolution));
    this.canvas.height = Math.max(1, Math.ceil((height + padding * 2) * resolution));
    this.configure(style);
    this.context.setTransform(resolution, 0, 0, resolution, 0, 0);
    this.context.fillStyle = '#000';
    this.context.fillText(text, padding + metrics.actualBoundingBoxLeft, padding + metrics.actualBoundingBoxAscent);
    const pixels = this.context.getImageData(0, 0, this.canvas.width, this.canvas.height).data;
    const result: Contour[] = [];
    let start = -1, roof = -1, deepest = -1;
    const commit = (end: number) => {
      if (start >= 0 && (end - start) / resolution >= 4) result.push({ left: start / resolution - padding, right: end / resolution - padding, top: deepest / resolution - padding });
    };
    for (let x = 0; x <= this.canvas.width; x++) {
      let row = -1;
      if (x < this.canvas.width) {
        for (let y = 0; y < this.canvas.height; y++) {
          if (pixels[(y * this.canvas.width + x) * 4 + 3]! >= 64) { row = y; break; }
        }
      }
      if (row >= 0 && start >= 0 && Math.abs(row - roof) <= 1) { deepest = Math.max(deepest, row); continue; }
      commit(x);
      start = row >= 0 ? x : -1;
      roof = deepest = row;
    }
    if (this.contours.size >= 256) this.contours.delete(this.contours.keys().next().value!);
    this.contours.set(key, result);
    return result;
  }
}
