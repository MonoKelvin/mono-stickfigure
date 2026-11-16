import { BONES, JOINT, FOOT_HEEL_LENGTH, FOOT_TOE_LENGTH } from '../animation/rig';
import type { Pose } from '../animation/rig';
import type { Point } from '../scene/types';
import type { Appearance } from '../types';

export class CanvasRenderer {
  readonly element: HTMLCanvasElement;
  private readonly context: CanvasRenderingContext2D;
  private readonly size: number;
  private dpr = 0;
  private visible = false;
  private rootX = Number.NaN;
  private rootY = Number.NaN;
  private readonly drawnJoints = new Float64Array(24);
  private readonly drawnFootAngles = new Float64Array(2);
  private drawn = false;
  private drawnFacingScale = 0;
  private drawnHeadRadius = 0;
  private drawnColor = '';
  private drawnLineWidth = 0;
  private drawnHeight = 0;
  private drawnHead: Appearance['head'] | undefined;

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
    const center = this.size / 2;
    const baseline = this.size * 0.65;
    // Keep subpixel client coordinates intact; moving the existing bitmap does
    // not require repainting an unchanged pose or rewriting an unchanged style.
    if (root.x !== this.rootX || root.y !== this.rootY) {
      this.element.style.transform = `translate(${root.x - center}px, ${root.y - baseline}px)`;
      this.rootX = root.x;
      this.rootY = root.y;
    }
    const dpr = Math.min(this.doc.defaultView!.devicePixelRatio || 1, this.maxDpr);
    const ctx = this.context;
    const resized = dpr !== this.dpr;
    if (resized) {
      this.dpr = dpr;
      this.element.width = Math.ceil(this.size * dpr);
      this.element.height = Math.ceil(this.size * dpr);
      // Resizing resets the context. The local root transform and invariant
      // drawing state otherwise survive clearRect and can be reused each frame.
      ctx.setTransform(dpr, 0, 0, dpr, center * dpr, baseline * dpr);
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.globalAlpha = 1;
    }
    const appearanceChanged = this.drawnColor !== this.appearance.color || this.drawnLineWidth !== this.appearance.lineWidth
      || this.drawnHeight !== this.appearance.height || this.drawnHead !== this.appearance.head;
    let poseChanged = !this.drawn || this.drawnFacingScale !== pose.facingScale || this.drawnHeadRadius !== pose.headRadius;
    for (let i = 0; !poseChanged && i < this.drawnJoints.length; i++) poseChanged = this.drawnJoints[i] !== pose.joints[i];
    for (let i = 0; !poseChanged && i < this.drawnFootAngles.length; i++) poseChanged = this.drawnFootAngles[i] !== pose.footAngles[i];
    if (!resized && !appearanceChanged && !poseChanged) return;

    // The canvas is already character-sized (3h by 3h), so clearing that small
    // bitmap is simpler and safer than changing crop bounds as limbs/rolls move.
    ctx.clearRect(-center, -baseline, this.size, this.size);
    if (resized || this.drawnColor !== this.appearance.color) {
      ctx.strokeStyle = this.appearance.color;
      ctx.fillStyle = this.appearance.color;
    }
    if (resized || this.drawnLineWidth !== this.appearance.lineWidth) ctx.lineWidth = this.appearance.lineWidth;
    ctx.beginPath();
    for (const [from, to] of BONES) {
      ctx.moveTo(pose.joints[from * 2]!, pose.joints[from * 2 + 1]!);
      ctx.lineTo(pose.joints[to * 2]!, pose.joints[to * 2 + 1]!);
    }
    const direction = pose.facingScale;
    for (let index = 0; index < 2; index++) {
      const foot = index === 0 ? JOINT.leftFoot : JOINT.rightFoot;
      const x = pose.joints[foot * 2]!;
      const y = pose.joints[foot * 2 + 1]!;
      const angle = pose.footAngles[index]!;
      const dx = Math.cos(angle) * this.appearance.height;
      const dy = Math.sin(angle) * this.appearance.height;
      ctx.moveTo(x - direction * dx * FOOT_HEEL_LENGTH, y - dy * FOOT_HEEL_LENGTH);
      ctx.lineTo(x + direction * dx * FOOT_TOE_LENGTH, y + dy * FOOT_TOE_LENGTH);
    }
    ctx.stroke();

    const x = pose.joints[JOINT.head * 2]!;
    const y = pose.joints[JOINT.head * 2 + 1]!;
    ctx.beginPath();
    if (this.appearance.head === 'circle') ctx.arc(x, y, pose.headRadius, 0, Math.PI * 2);
    else ctx.rect(x - pose.headRadius, y - pose.headRadius, pose.headRadius * 2, pose.headRadius * 2);
    ctx.fill();
    // Copy values, not references: the animation sampler mutates Pose in place.
    this.drawnJoints.set(pose.joints);
    this.drawnFootAngles.set(pose.footAngles);
    this.drawnFacingScale = pose.facingScale;
    this.drawnHeadRadius = pose.headRadius;
    this.drawnColor = this.appearance.color;
    this.drawnLineWidth = this.appearance.lineWidth;
    this.drawnHeight = this.appearance.height;
    this.drawnHead = this.appearance.head;
    this.drawn = true;
  }

  setVisible(visible: boolean): void {
    if (visible === this.visible) return;
    this.element.style.display = visible ? 'block' : 'none';
    this.visible = visible;
  }

  destroy(): void {
    this.element.remove();
    this.element.width = 0;
    this.element.height = 0;
  }
}
