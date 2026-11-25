import { describe, expect, it } from 'vitest';
import { tellStory } from '../../src/lib/solana/launch';

/**
 * The story of a launch whose creator passed its supply on with nothing paid
 * back (BONK, 2022: 24 transfers, most into Streamflow escrows; staging said
 * "selling back 20.08 %" on 25/11/2026).
 */

const CREATOR = '9AhKqLR67hwapvG8SA2JFXaCshXc9nALJjpKaHZrsbkw';
const CREATION =
  '2K5X6HT9QZ8dcApbWL6mzYw6WBDvL5vWndTpGrFkQuMfuStGTP5LxPNQnnn5v5KR2T6UD1zEXnfCdajzUfuCPZgS';
const ESCROW = 'AqYCkrLuuVqRjehq58KjZkPgBnxnDmreZo3Dh6w2xmM4';
const WALLET = 'ByjcyGru3RTeAheTjoFJi7mL8knNmzHz1twuoqjbjRtF';

type Input = Parameters<typeof tellStory>[0];
type Move = Input['moves'][number];

const send = (actor: string, value: bigint, seconds: number, lock?: string): Move => ({
  kind: 'allocation',
  actor,
  counterparty: CREATOR,
  value,
  slot: 165714665 + seconds,
  blockTime: null,
  transaction: `tx${seconds}`,
  payer: CREATOR,
  quote: null,
  seconds,
  index: seconds,
  ...(lock ? { lock } : {}),
});

const input = (sends: Move[]): Input => ({
  creation: {
    signature: CREATION,
    slot: 165714665,
    launchedAt: null,
    payer: CREATOR,
    signers: [CREATOR],
    foundBy: 'creation-time',
  },
  creator: CREATOR,
  moves: sends,
  kindOf: (o) => (o === CREATOR || o === WALLET ? 'wallet' : 'contract'),
  programOf: new Map(),
  share: (v) => Number(v) / 1e19,
  creatorAtLaunch: 0n,
  payerAtLaunch: 0n,
  creationBought: new Map(),
  sameSlot: null,
  payerGroup: null,
  payerGroupWithCreation: false,
  bundle: null,
  earlyBought: new Map(),
  earlySlot: 0,
  earlySeconds: 10,
  earlyCut: false,
  earlyWithin: 0,
  windowSeconds: 1039042,
  roundTrips: [],
  creatorSales: [],
  creatorSends: sends,
  read: 30,
  changed: 25,
  lastSlot: 2338915,
  beyond: true,
});

describe('tellStory: the creator’s transfers', () => {
  it('says what it passed on, into which lock, and that these are not sales', () => {
    const story = tellStory(
      input([
        send(WALLET, 2_000_000_000_000_000n, 599428),
        send(ESCROW, 95_476_190_476_195_250n, 621148, 'Streamflow'),
      ]),
    ).map((l) => l.text);
    expect(story).toContain(
      'The creator transferred 0.97% of the supply to 2 other addresses with no payment read in return, 0.95% of it into Streamflow: transfers, not sales.',
    );
    expect(story.join(' ')).not.toMatch(/creator sold/);
  });

  it('says nothing of transfers when there was none', () => {
    const story = tellStory(input([])).map((l) => l.text);
    expect(story.join(' ')).not.toMatch(/transferred/);
  });
});
