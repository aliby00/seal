import { describe, expect, it } from 'vitest';
import { usd } from '../../src/app/components/FactsBoard';

describe('usd', () => {
  it.each([
    [null, '—'],
    [0, '$0'],
    [0.5, '$0.5'],
    [0.000123456, '$0.0001235'],
    [0.00001, '$0.0₄1'],
    [0.00005, '$0.0₄5'],
    [1.234e-7, '$0.0₆1234'],
    [1.5, '$1.50'],
    [999_999, '$1.00M'],
    [999.97, '$1.0k'],
    [12_345, '$12.3k'],
  ])('%s → %s', (value, expected) => {
    expect(usd(value)).toBe(expected);
  });
});
