import { BONES, JOINT } from '../animation/rig';
import type { Pose } from '../animation/rig';
import type { Point } from '../scene/types';
import type { Appearance } from '../types';

export class CanvasRenderer {
  readonly element: HTMLCanvasElement;
  private readonly context: CanvasRenderingContext2D;
  private readonly size: number;
  private dpr = 0;

  constructor(private readonly doc: Document, mount: HTMLElement, private readonly appearance: Appearance, private readonly maxDpr: number) {
    this.size = Math.ceil(appearance.height * 3);
    this.element = doc.createElement('canvas');
    this.element.setAttribute('data-mono-stickfigure', '');
    this.element.setAttribute('aria-hidden', 'true');
    Object.assign(this.element.style, {
      position: 'fixed', top: '0', left: '0', width: `${this.size}px`, height: `${this.size}px`,
      pointerEvents: 'none', zIndex: '1000', margin: '0', padding: '0', border: '0',
      display: 'none', transformOrigin: '0 0',
    });
    const context = this.element.getContext('2d');
    if (!context) throw new Error('CANVAS_UNAVAILABLE: 当前环境不能创建 Canvas 2D 上下文');
    this.context = context;
    mount.append(this.element);
  }

  draw(root: Point, pose: Pose): void {
    const dpr = Math.min(this.doc.defaultView!.devicePixelRatio || 1, this.maxDpr);
    if (dpr !== this.dpr) {
      this.dpr = dpr;
      this.element.width = Math.ceil(this.size * dpr);
      this.element.height = Math.ceil(this.size * dpr);
    }
    const ctx = this.context;
    const center = this.size / 2;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, this.size, this.size);
    ctx.translate(center, this.size * 0.65);
    ctx.strokeStyle = this.appearance.color;
    ctx.lineWidth = this.appearance.lineWidth;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    for (const [from, to] of BONES) {
      if (from === JOINT.head) continue;
      ctx.moveTo(pose.joints[from * 2]!, pose.joints[from * 2 + 1]!);
      ctx.lineTo(pose.joints[to * 2]!, pose.joints[to * 2 + 1]!);
    }
    ctx.stroke();
    const x = pose.joints[JOINT.head * 2]!;
    const y = pose.joints[JOINT.head * 2 + 1]!;
    ctx.beginPath();
    if (this.appearance.head === 'circle') ctx.arc(x, y, pose.headRadius, 0, Math.PI * 2);
    else ctx.rect(x - pose.headRadius, y - pose.headRadius, pose.headRadius * 2, pose.headRadius * 2);
    ctx.stroke();
    this.element.style.transform = `translate(${root.x - center}px, ${root.y - this.size * 0.65}px)`;
  }

  setVisible(visible: boolean): void {
    this.element.style.display = visible ? 'block' : 'none';
  }

  destroy(): void {
    this.element.remove();
    this.element.width = 0;
    this.element.height = 0;
  }
}
