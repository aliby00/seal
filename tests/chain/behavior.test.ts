import { describe, expect, it } from 'vitest';
import {
  BURN_TOPIC,
  TRANSFER_TOPIC,
  detectCreatorSales,
  detectLiquidityRemovals,
  isRealLiquidityRemoval,
  topicFor,
  type RawLog,
  type RpcClient,
} from '../../src/lib/chain';

const CREATOR = '0xe06289fde414ee521aba50db0cf0a60816faa523';
const TOKEN = '0x494ddf6f7b4b045ede0abbb9ae86e4d59fa62ec9';
const POOL = '0x668942551affd4ee3a2e570366aaef28b56c3a97';
const OTHER = '0x1111111111111111111111111111111111111111';

function word(n: bigint): string {
  return n.toString(16).padStart(64, '0');
}

function nodeReturning(logs: RawLog[]): RpcClient {
  return {
    async call<T>(): Promise<T> {
      return logs as unknown as T;
    },
    async callBatch<T>(): Promise<never[]> {
      throw new Error('non utilisé');
    },
  } as unknown as RpcClient;
}

describe('topicFor', () => {
  it('pade une adresse à 32 octets', () => {
    expect(topicFor(CREATOR)).toBe(`0x000000000000000000000000${CREATOR.slice(2)}`);
  });
});

describe('isRealLiquidityRemoval', () => {
  const burn = (liquidity: bigint): RawLog => ({
    address: POOL,
    topics: [BURN_TOPIC],
    data: `0x${word(liquidity)}${word(0n)}${word(0n)}`,
    blockNumber: '0x1',
    transactionHash: '0xa',
    logIndex: '0x0',
  });

  // Le piège vérifié en direct : sur les trois Burn observés sur un pool réel,
  // les trois avaient liquidity = 0. Les compter aurait annoncé « liquidité
  // retirée trois fois » là où rien n'avait été retiré.
  it("ignore burn(0), qui n'est qu'une comptabilisation de frais", () => {
    expect(isRealLiquidityRemoval(burn(0n))).toBe(false);
  });

  it('reconnaît un retrait réel', () => {
    expect(isRealLiquidityRemoval(burn(1_000_000n))).toBe(true);
  });

  it('ne plante pas sur une donnée tronquée', () => {
    expect(isRealLiquidityRemoval({ ...burn(0n), data: '0x' })).toBe(false);
  });
});

describe('detectCreatorSales', () => {
  const pairs = [{ token: TOKEN as `0x${string}`, pool: POOL as `0x${string}` }];
  const window = { fromBlock: 0, toBlock: 100 };

  const transfer = (to: string): RawLog => ({
    address: TOKEN,
    topics: [TRANSFER_TOPIC, topicFor(CREATOR), topicFor(to)],
    data: `0x${word(1n)}`,
    blockNumber: '0x1',
    transactionHash: '0xa',
    logIndex: '0x0',
  });

  it('compte un transfert vers le pool comme une vente', async () => {
    const out = await detectCreatorSales(
      nodeReturning([transfer(POOL)]),
      CREATOR as `0x${string}`,
      pairs,
      window,
    );
    expect(out.get(TOKEN)).toBe(true);
  });

  // Envoyer ses tokens vers un autre wallet n'est pas une vente : c'est ambigu,
  // et l'annoncer comme un dump serait une accusation non fondée.
  it('ne compte pas un transfert vers un autre wallet', async () => {
    const out = await detectCreatorSales(
      nodeReturning([transfer(OTHER)]),
      CREATOR as `0x${string}`,
      pairs,
      window,
    );
    expect(out.get(TOKEN)).toBe(false);
  });

  it("renvoie false, pas undefined, quand rien n'est observé", async () => {
    const out = await detectCreatorSales(
      nodeReturning([]),
      CREATOR as `0x${string}`,
      pairs,
      window,
    );
    expect(out.get(TOKEN)).toBe(false);
  });

  it('ne fait aucun appel sans token', async () => {
    const rpc = nodeReturning([]);
    expect((await detectCreatorSales(rpc, CREATOR as `0x${string}`, [], window)).size).toBe(0);
  });
});

describe('detectLiquidityRemovals', () => {
  const pairs = [{ token: TOKEN as `0x${string}`, pool: POOL as `0x${string}` }];
  const window = { fromBlock: 0, toBlock: 100 };

  const burn = (liquidity: bigint): RawLog => ({
    address: POOL,
    topics: [BURN_TOPIC],
    data: `0x${word(liquidity)}${word(0n)}${word(0n)}`,
    blockNumber: '0x1',
    transactionHash: '0xa',
    logIndex: '0x0',
  });

  it('signale un retrait réel', async () => {
    const out = await detectLiquidityRemovals(nodeReturning([burn(5n)]), pairs, window);
    expect(out.get(TOKEN)).toBe(true);
  });

  it('ne signale rien sur des burn(0)', async () => {
    const out = await detectLiquidityRemovals(
      nodeReturning([burn(0n), burn(0n), burn(0n)]),
      pairs,
      window,
    );
    expect(out.get(TOKEN)).toBe(false);
  });
});
