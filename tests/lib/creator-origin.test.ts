import { describe, expect, it } from 'vitest';
import { creatorOrigin, graduationLine } from '../../src/app/components/FactsBoard';
import type { ReportFacts } from '../../src/lib/facts';

const base: ReportFacts['creator'] = {
  measured: true,
  address: 'D234v6HgjNdTfS8vYa3ZfJAF5sSoTVzrKCDmQ2ypCnQK',
  launched: 1,
  detailed: 1,
  graduated: 0,
  abandoned: 0,
  undetermined: 1,
  active: 0,
  checked: 1,
  soldIntoPool: 0,
  liquidityPulled: 0,
  salesChecked: 1,
  liquidityChecked: 0,
  source: null,
  role: null,
  launchContract: null,
  launchesListed: true,
  transactionCount: null,
};

describe('creatorOrigin', () => {
  it('says the creator was named by the token’s pump.fun curve', () => {
    expect(creatorOrigin({ ...base, launchpad: 'pump.fun', creatorFrom: 'launch-record' })).toBe(
      'Named as creator by the token’s pump.fun bonding curve.',
    );
  });

  it('never says a fee payer launched the token, launchpad or not', () => {
    const text = creatorOrigin({
      ...base,
      launchpad: 'Meteora Dynamic Bonding Curve',
      creatorFrom: 'transaction',
    });
    expect(text).toMatch(/^Paid for the transaction that created the mint\./);
    expect(text).toMatch(/does not prove who made the token/);
    expect(text).not.toMatch(/Launched/);
  });

  it('says nothing for an origin it does not know, even with a launchpad', () => {
    // The metadata's update authority: the Solana creator card says it.
    expect(creatorOrigin({ ...base, launchpad: 'pump.fun', creatorFrom: null })).toBeNull();
  });

  it('says a fee payer does not prove who made the token', () => {
    expect(creatorOrigin({ ...base, creatorFrom: 'transaction' })).toMatch(
      /^Paid for the transaction that created the mint\. A launch service can pay it: this does not prove/,
    );
  });

  it('shortens an address in base58 without changing its case', () => {
    expect(
      creatorOrigin({
        ...base,
        role: 'launcher',
        launchContract: '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',
      }),
    ).toBe('Launched the token through 6EF8…wF6P.');
  });

  it('says nothing when the origin is unknown', () => {
    expect(creatorOrigin(base)).toBeNull();
  });
});

describe('graduation line', () => {
  it('says graduation does not apply, or was not measured, rather than drawing zeros', () => {
    expect(graduationLine({ ...base, graduation: 'not-applicable' })).toMatch(/does not apply/);
    expect(graduationLine({ ...base, graduation: 'not-measured', launchpad: 'pump.fun' })).toBe(
      'Graduation is read on pump.fun, Meteora DBC and Raydium LaunchLab curves: not measured on pump.fun.',
    );
  });
});
