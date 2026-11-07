import { describe, expect, it } from 'vitest';
import { ReadLedger } from '../../src/lib/reads';

describe('ReadLedger: a deadline for every optional read', () => {
  it('files a read still running at the deadline as one that did not finish', async () => {
    const ledger = new ReadLedger(Date.now() + 20);
    const outcome = await ledger.read('creator-fees', () => new Promise(() => {}));
    expect(outcome.status).toBe('failed');
    expect(ledger.all[0]?.note).toMatch(/did not finish in time/);
  });

  it('leaves a read that answers in time as it is', async () => {
    const ledger = new ReadLedger(Date.now() + 1_000);
    const outcome = await ledger.read('creator-fees', async () => 3);
    expect(outcome).toEqual({ status: 'ok', value: 3 });
    expect(ledger.all).toHaveLength(0);
  });
});
