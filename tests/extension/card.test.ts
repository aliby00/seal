import { describe, expect, it } from 'vitest';
import { ext, type VNode } from './ext';
import { SAMPLE } from './sample';

const { renderCard, textOf, findAll, safeHref } = ext.card;

const byClass = (tree: VNode, name: string) =>
  findAll(tree, (n) => (n.attrs.class ?? '').split(' ').includes(name));

describe('the In-short card', () => {
  const tree = renderCard({ status: 'ready', data: SAMPLE });
  const text = textOf(tree);

  it('names the token and leads with the first line, its tone said in words', () => {
    expect(text).toContain('Alpha Token · ALP');
    const [lead] = byClass(tree, 'lead');
    expect(lead?.attrs['data-tone']).toBe('attention');
    expect(textOf(lead!)).toContain('Worth attention');
    expect(textOf(lead!)).toContain('7/10');
    expect(textOf(lead!)).toContain('The creator sold into the pool on 7 of 10 launches checked.');
  });

  it('shows up to three more lines, and two in the compact hover card', () => {
    expect(findAll(tree, (n) => n.tag === 'li')).toHaveLength(3);
    const compact = renderCard({ status: 'ready', data: SAMPLE }, { compact: true });
    expect(findAll(compact, (n) => n.tag === 'li')).toHaveLength(2);
    expect(textOf(compact)).not.toContain('Sales found in each launch');
  });

  it('says what was not measured, and links to the full reading', () => {
    expect(text).toContain(
      'Not measured here: live trading on an open market. Missing data is not good news, nor bad news.',
    );
    const [link] = findAll(tree, (n) => n.tag === 'a');
    expect(link?.attrs.href).toBe(SAMPLE.url);
    expect(link?.attrs.rel).toBe('noopener noreferrer');
    expect(textOf(link!)).toBe('Full reading on SEAL ');
  });

  it('never scores, never says safe or risky', () => {
    expect(text).not.toMatch(/score\b(?!\.)|\bsafe\b|risky|scam|\brug\b|\/100/i);
    expect(text).toContain('Never a score.');
  });

  it('falls back to the headline and the short address when little is known', () => {
    const bare = renderCard({
      status: 'ready',
      data: {
        ...SAMPLE,
        name: null,
        symbol: null,
        glance: {
          headline: 'Too little could be measured on this token to sum it up.',
          items: [],
          unseen: [],
        },
      },
    });
    expect(textOf(bare)).toContain('0x10E8…f18B');
    expect(textOf(bare)).toContain('Too little could be measured');
    expect(findAll(bare, (n) => n.tag === 'ul')).toHaveLength(0);
  });

  it('keeps a hostile name as text and drops a script link', () => {
    const hostile = renderCard({
      status: 'ready',
      data: { ...SAMPLE, name: '<img src=x onerror=alert(1)>', url: 'javascript:alert(1)' },
    });
    expect(textOf(hostile)).toContain('<img src=x onerror=alert(1)>');
    expect(findAll(hostile, (n) => n.tag === 'img')).toHaveLength(0);
    expect(findAll(hostile, (n) => n.tag === 'a')).toHaveLength(0);
    expect(safeHref('javascript:alert(1)')).toBeNull();
  });

  it('has a plain-English loading and error state', () => {
    const loading = renderCard({ status: 'loading' });
    expect(loading.attrs['aria-busy']).toBe('true');
    expect(textOf(loading)).toContain('reading this token');
    const error = renderCard({
      status: 'error',
      message: 'SEAL could not read this token right now.',
      retry: true,
    });
    expect(textOf(error)).toContain('SEAL could not read this token right now.');
    expect(findAll(error, (n) => n.attrs['data-action'] === 'retry')).toHaveLength(1);
  });

  it('can be closed by a labelled button, unless shown in the popup', () => {
    expect(findAll(tree, (n) => n.attrs['aria-label'] === 'Close')).toHaveLength(1);
    const popup = renderCard({ status: 'ready', data: SAMPLE }, { closable: false });
    expect(findAll(popup, (n) => n.attrs['aria-label'] === 'Close')).toHaveLength(0);
  });

  it('respects reduced motion', () => {
    expect(ext.CSS).toContain('prefers-reduced-motion: reduce');
  });
});
