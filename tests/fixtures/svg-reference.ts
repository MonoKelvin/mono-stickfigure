import { BONES, JOINT } from '../../src/animation/rig';
import type { Pose } from '../../src/animation/rig';
import type { Point } from '../../src/scene/types';

export function createSvgReference(doc: Document, mount: HTMLElement, height: number, color: string) {
  const ns = 'http://www.w3.org/2000/svg';
  const element = doc.createElementNS(ns, 'svg');
  element.setAttribute('data-mono-stickfigure', 'svg-reference');
  element.setAttribute('aria-hidden', 'true');
  element.setAttribute('viewBox', `${-height * 1.5} ${-height * 1.95} ${height * 3} ${height * 3}`);
  Object.assign(element.style, { position: 'fixed', left: '0', top: '0', width: `${height * 3}px`, height: `${height * 3}px`, pointerEvents: 'none', zIndex: '1000' });
  element.setAttribute('fill', 'none');
  element.setAttribute('stroke', color);
  element.setAttribute('stroke-width', '2');
  element.setAttribute('stroke-linecap', 'round');
  const bones = BONES.filter(([from]) => from !== JOINT.head);
  const lines = bones.map(() => doc.createElementNS(ns, 'line'));
  const head = doc.createElementNS(ns, 'circle');
  element.append(...lines, head);
  mount.append(element);
  return {
    element,
    draw(root: Point, pose: Pose) {
      bones.forEach(([from, to], index) => {
        const line = lines[index]!;
        line.setAttribute('x1', String(pose.joints[from * 2]));
        line.setAttribute('y1', String(pose.joints[from * 2 + 1]));
        line.setAttribute('x2', String(pose.joints[to * 2]));
        line.setAttribute('y2', String(pose.joints[to * 2 + 1]));
      });
      head.setAttribute('cx', String(pose.joints[JOINT.head * 2]));
      head.setAttribute('cy', String(pose.joints[JOINT.head * 2 + 1]));
      head.setAttribute('r', String(pose.headRadius));
      element.style.transform = `translate(${root.x - height * 1.5}px, ${root.y - height * 1.95}px)`;
    },
    destroy() { element.remove(); },
  };
}
