import { describe, expect, it } from 'vitest';
import { creatorOrigin, graduationLine } from '../../src/app/components/FactsBoard';
import type { ReportFacts } from '../../src/lib/facts';

const base: ReportFacts['creator'] = {
  measured: true,
  address: '0xc47f000000000000000000000000000000001234',
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
  source: 'deployer',
  role: 'deployer',
  launchContract: null,
  launchesListed: true,
  transactionCount: 11,
};

describe('creatorOrigin', () => {
  it('dit comment le créateur a été trouvé', () => {
    expect(creatorOrigin({ ...base, source: 'pons', role: null })).toMatch(/pons launch record/);
    expect(creatorOrigin(base)).toBe('Deployed the token contract.');
    expect(
      creatorOrigin({
        ...base,
        role: 'launcher',
        launchContract: '0xabcdef0000000000000000000000000000009876',
      }),
    ).toBe('Launched the token through 0xabcd…9876.');
  });

  it('nuance le premier mint : il ne prouve pas qui a écrit le token', () => {
    expect(creatorOrigin({ ...base, role: 'first-minter' })).toMatch(/does not prove/);
  });

  it('ne dit rien quand l’origine est inconnue', () => {
    expect(creatorOrigin({ ...base, source: null, role: null })).toBeNull();
  });
});

describe('creator origin on a known launchpad', () => {
  it('says where the creator was read', () => {
    expect(
      creatorOrigin({
        ...base,
        source: 'deployer',
        launchpad: 'flap.sh',
        creatorFrom: 'launch-record',
      }),
    ).toBe('Found from their flap.sh launch record.');
    expect(
      creatorOrigin({
        ...base,
        source: 'deployer',
        launchpad: 'flap.sh',
        creatorFrom: 'transaction',
      }),
    ).toBe('Launched the token through flap.sh: the sender of that transaction.');
  });

  it('says graduation does not apply, or was not measured, rather than drawing zeros', () => {
    expect(graduationLine({ ...base, graduation: 'not-applicable' })).toMatch(/does not apply/);
    expect(graduationLine({ ...base, graduation: 'not-measured', launchpad: 'flap.sh' })).toBe(
      'Graduation is read for pons and Virtuals launches only: not measured on flap.sh.',
    );
  });
});
