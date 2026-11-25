import type { TokenReport } from '../../src/lib/contracts';

/**
 * A Solana report for the tests that need one without reading anything: a
 * pump.fun token still on its curve, its creator, a few holders, a listed
 * market. Every figure here is made up for the test; addresses are valid
 * base58 strings of 32 bytes. Blocks are replaced whole through `overrides`.
 */
export const MINT = 'FB5eSv7CAMWJnrH5GvHLivx9y8Qgoo8vpPV3EX5Npump';
export const CREATOR = 'D234v6HgjNdTfS8vYa3ZfJAF5sSoTVzrKCDmQ2ypCnQK';
export const HOLDER = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';
export const CURVE = '8j8apXSGYWc9m9XySAADCYmUzhetFzs2ZMoj36opQ8YA';
export const PAIR = '7NCEXHBRk5mMKpMwVkVJ7Nkpay4kDsaBYxkJuWrBybGd';

const AT = '2026-11-25T00:00:00.000Z';
const rpc = (note?: string) => [
  { name: 'solana-rpc' as const, fetchedAt: AT, ...(note ? { note } : {}) },
];

export function solanaReport(overrides: Partial<TokenReport> = {}): TokenReport {
  return {
    chain: 'solana',
    token: MINT,
    collectedAt: AT,
    mint: {
      completeness: 'full',
      sources: rpc(),
      data: {
        mint: MINT,
        program: 'token-2022',
        decimals: 6,
        supply: '1000000000000000',
        mintAuthority: null,
        freezeAuthority: null,
        extensions: [],
        metadata: {
          source: 'tokenMetadata',
          account: MINT,
          name: 'Test Token',
          symbol: 'TEST',
          uri: 'https://example.invalid/test.json',
          updateAuthority: null,
          isMutable: false,
          additionalMetadata: [],
        },
        epoch: null,
        readAt: AT,
        gaps: [],
      },
    },
    powers: [
      {
        power: 'mint',
        status: 'none',
        holder: null,
        sentence: 'Nobody can create more of this token.',
        from: 'mint',
      },
    ],
    creator: {
      completeness: 'full',
      sources: rpc(),
      data: {
        mint: MINT,
        creator: CREATOR,
        from: 'pump-curve',
        account: CURVE,
        creation: {
          signature:
            '5j7s1QzqC9kXcVnZ3wHhLKXqJ9x7GdSxF2X8b4T5dYhN8vQe2aZkKcV3pR1mWnYtUo6sLqPa9rDf4GhJk2LmNbVc',
          slot: 473491300,
          blockTime: 1795552482,
          feePayer: CREATOR,
          instruction: 'pump-create-v2',
          launchpad: 'pump.fun',
        },
        pumpCurve: { address: CURVE, complete: false },
      },
    },
    creatorHistory: {
      completeness: 'full',
      sources: rpc(),
      data: {
        creator: CREATOR,
        tokens: [],
        counts: { launched: 0, graduated: 0, dead: 0, active: 0, unknown: 0 },
        scanned: {
          pumpCurvesListed: true,
          curvesWithoutMint: 0,
          signatures: 13,
          signaturesComplete: true,
          transactionsListed: 13,
          transactionsRead: 12,
          readSince: 1795552000,
        },
      },
    },
    creatorOnToken: {
      completeness: 'full',
      sources: rpc(),
      data: {
        wallet: CREATOR,
        mint: MINT,
        bought: '0',
        sold: '0',
        received: '0',
        burned: '0',
        locked: '0',
        unlocked: '0',
        solSpent: '0',
        solReceived: '0',
        holdsNow: '0',
        holdsNowShare: 0,
        moves: [],
        accountsRead: [],
        transactions: { listed: 0, read: 0 },
        supply: '1000000000000000',
        decimals: 6,
        sends: { recipients: [], distinct: 0, burned: '0', total: '0' },
      },
    },
    linkedWallets: {
      completeness: 'full',
      sources: rpc(),
      data: {
        creator: CREATOR,
        mint: MINT,
        firstFunding: null,
        funding: 'none-seen',
        window: null,
        funded: [],
      },
    },
    holders: {
      completeness: 'full',
      sources: rpc(),
      data: {
        token: MINT,
        chain: 'solana',
        program: 'token-2022',
        decimals: 6,
        supply: '1000000000000000',
        method: 'all-accounts',
        accountsRead: 3,
        countedSupply: '200000000000000',
        holderCount: 2,
        holdersAtLeast: 2,
        top: [
          {
            address: HOLDER,
            balance: '150000000000000',
            share: 0.75,
            kind: 'wallet',
            owner: { kind: 'wallet', name: 'wallet', evidence: 'on the ed25519 curve' },
            ofSupply: 0.15,
            tokenAccounts: ['3Wq1p2y9zV9H8z7B1sYQ6kq5Jr4p8C2s1nXo7a6dLmTu'],
          },
          {
            address: CURVE,
            balance: '800000000000000',
            share: 0,
            kind: 'pool',
            role: 'curve',
            name: 'pump.fun bonding curve',
            owner: {
              kind: 'curve',
              name: 'pump.fun bonding curve',
              evidence: 'pump.fun BondingCurve account',
            },
            ofSupply: 0.8,
            tokenAccounts: ['4Rf9uHkqJrW7d3bN2pV8xE5cT1mZyA6sQ9wL2oK7jHgF'],
          },
        ],
        concentration: { top1: 0.75, top10: 1 },
        pooledShare: 0.8,
        setAside: [{ address: CURVE, role: 'curve', share: 0.8, name: 'pump.fun bonding curve' }],
        distinctTraders: null,
        ofSupply: {
          largestWallet: 0.15,
          top10Wallets: 0.2,
          pools: 0,
          curves: 0.8,
          burned: 0,
          locked: 0,
        },
      },
    },
    market: {
      completeness: 'full',
      sources: [{ name: 'dexscreener-solana', fetchedAt: AT }],
      data: {
        chain: 'solana',
        token: MINT,
        pair: PAIR,
        dex: 'pumpfun',
        pairedWith: { address: 'So11111111111111111111111111111111111111112', symbol: 'SOL' },
        priceUsd: 0.0000412,
        priceNative: 0.00000021,
        liquidityUsd: 12_000,
        volumeUsd: { m5: 0, h1: 300, h6: 900, h24: 2_400 },
        txns: { h1: { buys: 4, sells: 3 }, h24: { buys: 40, sells: 30 } },
        fdvUsd: 41_200,
        marketCapUsd: 41_200,
        pairCreatedAt: '2026-11-24T22:00:00.000Z',
        pools: [],
      },
    },
    launchpad: {
      completeness: 'full',
      sources: rpc(),
      data: {
        mint: MINT,
        launchpad: {
          id: 'pump.fun',
          name: 'pump.fun',
          program: '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',
        },
        account: CURVE,
        foundBy: 'curve-account',
      },
    },
    graduation: {
      completeness: 'full',
      sources: rpc(),
      data: {
        mint: MINT,
        launchpad: 'pump.fun',
        account: CURVE,
        graduated: false,
        progress: 0.2,
        progressBasis: 'tokens-sold',
        raised: null,
        target: null,
        destination: null,
        creator: CREATOR,
      },
    },
    liquidity: {
      completeness: 'full',
      sources: rpc('no pool to read'),
      data: { mint: MINT, pools: [] },
    },
    launch: {
      completeness: 'unavailable',
      sources: rpc('the creation was not found'),
      data: {
        chain: 'solana',
        token: MINT,
        tokenProgram: null,
        decimals: null,
        supply: null,
        creation: null,
        launchBlock: null,
        launchedAt: null,
        windowSeconds: 0,
        windowSlots: 0,
        moves: [],
        movesInWindow: 0,
        summary: null,
        sameSlot: null,
        payerGroup: null,
        roundTrips: [],
        transactions: {
          wanted: 0,
          read: 0,
          failed: 0,
          withoutChange: 0,
          beyond: 0,
          wholeHistory: false,
        },
        calls: 0,
        story: [],
      },
    },
    completeness: 'full',
    ...overrides,
  };
}
