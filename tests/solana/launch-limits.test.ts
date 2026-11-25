import { describe, expect, it } from 'vitest';
import { replayLaunch } from '../../src/lib/solana/launch';
import { TOKEN_PROGRAM } from '../../src/lib/solana/programs';
import { solanaRpcFrom, type SolanaCall } from '../../src/lib/solana/rpc';

/**
 * The limits a replay states when the token's history is too long to reach
 * its creation. They are shown to the reader ("What it could not see"):
 * Solana has slots, and a reader of SEAL should not meet EVM's "block"
 * (USDC on staging, 25/11/2026: "came before the block found from the
 * creation time given").
 */

const MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const CREATED_AT = 1_600_000_000;

/** A node where the mint has more signatures than any page, and blocks keep the time asked or none. */
function node(blockTime: number | null): SolanaCall {
  let n = 0;
  return (async (method: string) => {
    switch (method) {
      case 'getAccountInfo':
        return {
          context: { slot: 1 },
          value: {
            data: {
              program: 'spl-token',
              parsed: { type: 'mint', info: { supply: '1000000', decimals: 6 } },
              space: 82,
            },
            executable: false,
            lamports: 1,
            owner: TOKEN_PROGRAM,
            rentEpoch: 0,
            space: 82,
          },
        };
      case 'getSignaturesForAddress':
        return Array.from({ length: 1000 }, () => {
          n += 1;
          return { signature: `sig${n}`, slot: 1, err: null, blockTime: null, memo: null };
        });
      case 'getSlot':
        return 400_000_000;
      case 'getBlockTime':
        return blockTime;
      case 'getBlock':
        return { signatures: ['anchor'], blockTime };
      default:
        throw new Error(`not stubbed: ${method}`);
    }
  }) as SolanaCall;
}

const notes = async (blockTime: number | null) => {
  const replay = await replayLaunch(MINT, solanaRpcFrom(node(blockTime)), {
    createdAt: CREATED_AT,
    maxCalls: 1000,
  });
  return replay.sources.map((s) => s.note ?? '').join('; ');
};

describe('replayLaunch: the limits of a long history say slot, never block', () => {
  it('no slot found at the creation time given', async () => {
    const said = await notes(null);
    expect(said).toContain('no slot was found at the creation time given');
    expect(said).not.toMatch(/\bblocks?\b/);
  });

  it('more transactions before the slot found than can be listed', async () => {
    const said = await notes(CREATED_AT);
    expect(said).toContain(
      'more than 3,000 transactions came before the slot found from the creation time given',
    );
    expect(said).not.toMatch(/\bblocks?\b/);
  });
});
