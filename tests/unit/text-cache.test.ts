import { expect, it, vi } from 'vitest';
import { TextMeasurer } from '../../src/perception/text-surfaces';

it('exact text/font keys preserve cached segmentation and invalidate on changes', () => {
  const style = { fontStyle: 'normal', fontWeight: '400', fontSize: '16px', fontFamily: 'sans-serif', letterSpacing: 'normal', fontKerning: 'auto', textTransform: 'none', direction: 'ltr' };
  const doc = { createElement: () => ({ getContext: () => ({}) }), defaultView: { getComputedStyle: () => style } } as unknown as Document;
  const element = { ownerDocument: doc, closest: () => null } as unknown as Element;
  const node = { parentElement: element, data: 'Hello world 火柴人' } as unknown as Text;
  const measurer = new TextMeasurer(doc);
  const segment = vi.spyOn(Intl.Segmenter.prototype, 'segment');
  const hash = vi.spyOn(Math, 'imul');
  try {
    const initial = measurer.parts(node);
    expect(initial.length).toBeGreaterThan(0);
    for (let i = 0; i < 120; i++) expect(measurer.parts(node)).toBe(initial);
    expect(segment).toHaveBeenCalledTimes(1);
    expect(hash).not.toHaveBeenCalled();
    expect(measurer.revision(node)).toBe(1);
    Object.assign(node, { data: 'Hello updated world' });
    expect(measurer.parts(node)).not.toBe(initial);
    expect(measurer.revision(node)).toBe(2);
    style.fontSize = '48px';
    expect(measurer.parts(node).every(part => part.contour)).toBe(true);
    expect(measurer.revision(node)).toBe(3);
    expect(segment).toHaveBeenCalledTimes(3);
  } finally { segment.mockRestore(); hash.mockRestore(); }
});
