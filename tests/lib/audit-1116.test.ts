import { afterEach, describe, expect, it } from 'vitest';
import type { ReportFacts } from '../../src/lib/facts';
import { buildGlance, usdShort } from '../../src/lib/glance';
import { usdWords } from '../../src/lib/agent/offline';
import { readableNote } from '../../src/lib/plain-note';
import {
  classifyFailure,
  modelFailure,
  recordModelAnswer,
  recordModelFailure,
  resetModelHealth,
} from '../../src/lib/model-health';
import { setSharedRedis } from '../../src/lib/store';

/**
 * Prod, 16/11/2026: every reading served offline for days on a revoked key,
 * and the summary of a dead token (RBCAT: $0.39 of liquidity, 2 trades a day)
 * led with "100% to the creator at launch", true of any token deployed on its
 * own, and said its market held "$0".
 */

const CREATOR = '0x780a6b85d841b0750e91644cce6de349e6fb6cba';

function facts(over: Partial<ReportFacts> = {}): ReportFacts {
  return {
    creator: {
      measured: false,
      address: CREATOR,
      launched: 0,
      detailed: 0,
      graduated: 0,
      abandoned: 0,
      undetermined: 0,
      active: 0,
      checked: 0,
      soldIntoPool: 0,
      liquidityPulled: 0,
      salesChecked: 0,
      liquidityChecked: 0,
      source: null,
      role: null,
      launchContract: null,
      launchesListed: false,
      transactionCount: null,
    },
    holders: { measured: false, holderCount: null, pooled: null, top1: 0, top10: 0, top: [] },
    market: {
      measured: false,
      priceUsd: null,
      liquidityUsd: null,
      volume24hUsd: null,
      buys24h: null,
      sells24h: null,
      fdvUsd: null,
      graduation: null,
    },
    ...over,
  };
}

const deployedAlone = (heldNow: number): ReportFacts['supplyFlow'] => ({
  launchpad: null,
  windowSeconds: 600,
  roots: [
    {
      address: CREATOR,
      kind: 'creator',
      name: 'the creator',
      received: 1,
      heldNow,
      at: 0,
      tradable: true,
      children: [],
    },
  ],
  buys: 0,
});

const deadMarket: ReportFacts['market'] = {
  measured: true,
  priceUsd: 2.303e-10,
  liquidityUsd: 0.39,
  volume24hUsd: 1.93,
  buys24h: 1,
  sells24h: 1,
  fdvUsd: 23,
  graduation: null,
};

describe('glance: a token deployed on its own', () => {
  it('leads with what the creator still holds, not "100% to the creator at launch"', () => {
    const glance = buildGlance({ facts: facts({ supplyFlow: deployedAlone(0.294871) }) })!;
    const flow = glance.items.find((i) => i.id === 'flow')!;
    expect(flow.title).toBe(
      'The creator minted the whole supply to itself and still holds 29% of it.',
    );
    expect(flow.figure).toBe('29%');
    expect(flow.tone).toBe('attention');
    expect(glance.headline).not.toMatch(/100% to the creator/);
  });

  it('says when the creator holds none of it any more', () => {
    const flow = buildGlance({ facts: facts({ supplyFlow: deployedAlone(0) }) })!.items[0]!;
    expect(flow.title).toMatch(/holds none of it today/);
    expect(flow.tone).toBe('neutral');
  });
});

describe('glance: a market with next to nothing in it', () => {
  it('leads the summary and says how little still trades', () => {
    const glance = buildGlance({
      facts: facts({ supplyFlow: deployedAlone(0.294871), market: deadMarket }),
    })!;
    expect(glance.headline).toBe(
      'Its market is all but empty: $0.39 of liquidity. 2 trades in the last 24 hours.',
    );
    expect(glance.items[0]!.figure).toBe('$0.39');
    // What the creator holds still follows, once.
    expect(glance.items.filter((i) => i.id === 'flow')).toHaveLength(1);
    expect(glance.items.filter((i) => i.id === 'market')).toHaveLength(1);
  });

  it('keeps the thin-market line above a few dollars (FOBO: $159)', () => {
    const glance = buildGlance({
      facts: facts({ market: { ...deadMarket, liquidityUsd: 159 } }),
    })!;
    expect(glance.headline).toBe(
      'Its market holds only $159 of liquidity: a sale of a few hundred dollars moves its price.',
    );
  });

  it('never says "$0" for cents', () => {
    expect(usdShort(0.39)).toBe('$0.39');
    expect(usdShort(337)).toBe('$337');
    expect(usdShort(0)).toBe('$0');
  });
});

describe('offline wording: dollars as people read them', () => {
  it('writes small prices the way DexScreener does, never in e-notation', () => {
    expect(usdWords(2.303e-10)).toBe('$0.0₉2303');
    expect(usdWords(0.000003654)).toBe('$0.0₅3654');
    expect(usdWords(0.00001)).toBe('$0.0₄1');
    expect(usdWords(0.0123)).toBe('$0.0123');
    expect(usdWords(73.8)).toBe('$73.80');
    expect(usdWords(134000.21)).toBe('$134,000.21');
  });
});

describe('model health: a model that stops answering is seen', () => {
  afterEach(() => {
    resetModelHealth();
    setSharedRedis(undefined);
  });

  it('classifies a revoked key, a retired model and a timeout', () => {
    expect(
      classifyFailure(
        new Error(
          '401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}',
        ),
      ),
    ).toBe('auth');
    expect(classifyFailure(new Error('404 not_found_error: model: claude-x'))).toBe('model');
    expect(classifyFailure(new Error('Your credit balance is too low'))).toBe('billing');
    expect(classifyFailure(new Error('429 rate_limit_error'))).toBe('quota');
    expect(classifyFailure(new DOMException('The operation was aborted', 'AbortError'))).toBe(
      'timeout',
    );
  });

  it('keeps a lasting failure until the model answers again', async () => {
    setSharedRedis(null);
    await recordModelFailure(new Error('401 invalid x-api-key'), new Date('2026-11-16T13:27:41Z'));
    expect(await modelFailure()).toEqual({ kind: 'auth', at: '2026-11-16T13:27:41.000Z' });
    await recordModelAnswer();
    expect(await modelFailure()).toBeNull();
  });

  it('does not report a timeout: the call ran long, the model is not down', async () => {
    setSharedRedis(null);
    await recordModelFailure(new DOMException('The operation timed out', 'TimeoutError'));
    expect(await modelFailure()).toBeNull();
  });

  it('shares the failure through the store, so every instance reports it', async () => {
    const kv = new Map<string, string>();
    setSharedRedis({
      async pipeline(commands) {
        return commands.map(([cmd, key, value]) => {
          if (cmd === 'SET') kv.set(String(key), String(value));
          if (cmd === 'DEL') kv.delete(String(key));
          return cmd === 'GET' ? (kv.get(String(key)) ?? null) : 'OK';
        });
      },
    });
    await recordModelFailure(new Error('403 permission_error'));
    resetModelHealth();
    expect((await modelFailure())?.kind).toBe('auth');
    await recordModelAnswer();
    expect(await modelFailure()).toBeNull();
  });
});

describe('source notes as a reader takes them', () => {
  it('drops the error kind and the source name', () => {
    expect(
      readableNote(
        'incomplete : robinhood-rpc : incomplete data — the creator’s history did not finish in time this time; try again in a minute',
      ),
    ).toBe('the creator’s history did not finish in time this time; try again in a minute');
    expect(
      readableNote('upstream : dexscreener : network request failed', { sentence: true }),
    ).toBe('The source did not answer this time; try again in a minute');
  });

  it('leaves a note already written for people as it is', () => {
    expect(readableNote('Not covered: Doppler and direct deploys.')).toBe(
      'Not covered: Doppler and direct deploys.',
    );
  });
});
