import { describe, expect, it } from 'vitest';
import realLog from './fixtures/token-launched.json' with { type: 'json' };
import {
  ROBINHOOD_CHAIN_ID,
  addressTopic,
  classifyLogError,
  classifyOutcome,
  decodeTokenLaunched,
  getLogsChunked,
  toGraduationStatus,
  type RawLog,
  type RpcClient,
} from '../../src/lib/chain';

describe('classifyLogError — les trois refus du nœud', () => {
  it('reconnaît le dépassement de limite', () => {
    const e = classifyLogError('logs matched by query exceeds limit of 10000');
    expect(e?.reason).toBe('too-many-results');
  });

  // Mode d'échec découvert en rejouant la sonde : message totalement différent,
  // même remède. Un code qui ne verrait que le premier boucherait ici.
  it('reconnaît le timeout de requête', () => {
    expect(classifyLogError('log query timed out')?.reason).toBe('timeout');
  });

  it('laisse passer une erreur sans rapport', () => {
    expect(classifyLogError('execution reverted')).toBeUndefined();
  });
});

describe('decodeTokenLaunched sur un log réel', () => {
  const launch = decodeTokenLaunched(realLog as RawLog);

  it('décode les trois paramètres indexés', () => {
    expect(launch.token.toLowerCase()).toBe('0x494ddf6f7b4b045ede0abbb9ae86e4d59fa62ec9');
    expect(launch.deployer.toLowerCase()).toBe('0xe06289fde414ee521aba50db0cf0a60816faa523');
    // dexFactory pointe sur le factory Uniswap V3 — pas v4, contrairement aux docs tierces.
    expect(launch.dexFactory.toLowerCase()).toBe('0x1f7d7550b1b028f7571e69a784071f0205fd2efa');
  });

  it('décode les champs de data', () => {
    // pairToken est WETH ; pool est l'adresse que DexScreener renvoie comme pairAddress.
    expect(launch.pairToken.toLowerCase()).toBe('0x0bd7d308f8e1639fab988df18a8011f41eacad73');
    expect(launch.pool.toLowerCase()).toBe('0x668942551affd4ee3a2e570366aaef28b56c3a97');
    expect(launch.initialBuyAmount).toBe(100_000_000_000_000n);
  });

  it('retient le factory émetteur, pas celui de la documentation', () => {
    expect(launch.factory.toLowerCase()).toBe('0xf4fc0cd27fc8ecf17e55ee4c3f7201897df3eb75');
  });
});

describe('toGraduationStatus', () => {
  it('convertit les wei et calcule la progression', () => {
    const status = toGraduationStatus(2_235_290_486_865_066n, 4_200_000_000_000_000_000n, false);
    expect(status.thresholdEth).toBeCloseTo(4.2);
    expect(status.pairedEth).toBeCloseTo(0.002235, 6);
    expect(status.progress).toBeCloseTo(0.000532, 5);
    expect(status.graduated).toBe(false);
  });

  it('borne la progression à 1 au-delà du seuil', () => {
    const status = toGraduationStatus(9_000_000_000_000_000_000n, 4_200_000_000_000_000_000n, true);
    expect(status.progress).toBe(1);
  });

  it('ne divise pas par zéro si le seuil est nul', () => {
    expect(toGraduationStatus(1n, 0n, false).progress).toBe(0);
  });
});

describe('classifyOutcome', () => {
  const graduated = toGraduationStatus(5n, 4n, true);
  const young = toGraduationStatus(1n, 4_200_000_000_000_000_000n, false);

  it('gradué prime sur tout le reste', () => {
    expect(classifyOutcome(graduated, 999_999_999)).toBe('graduated');
  });

  it('actif tant que le lancement est récent', () => {
    expect(classifyOutcome(young, 1_000)).toBe('active');
  });

  it('abandonné après une longue inactivité sous le seuil', () => {
    expect(classifyOutcome(young, 30_000_000)).toBe('abandoned');
  });

  it('traite un statut absent comme non gradué', () => {
    expect(classifyOutcome(null, 1_000)).toBe('active');
  });
});

describe('addressTopic', () => {
  it("pade l'adresse à 32 octets pour servir de filtre indexé", () => {
    expect(addressTopic('0xE06289fde414EE521aBA50Db0Cf0a60816FAA523')).toBe(
      '0x000000000000000000000000e06289fde414ee521aba50db0cf0a60816faa523',
    );
  });
});

/** Nœud simulé : on contrôle exactement quand il refuse, et pourquoi. */
function fakeNode(opts: {
  maxSpan: number;
  logsPerBlock?: number;
  failWith?: 'exceeds limit of 10000' | 'log query timed out';
}): { rpc: RpcClient; calls: { from: number; to: number }[] } {
  const calls: { from: number; to: number }[] = [];
  const rpc: RpcClient = {
    async call<T>(_method: string, params: unknown[]): Promise<T> {
      const filter = (params as [{ fromBlock: string; toBlock: string }])[0];
      const from = Number(filter.fromBlock);
      const to = Number(filter.toBlock);
      calls.push({ from, to });
      if (to - from + 1 > opts.maxSpan) {
        const message = opts.failWith ?? 'exceeds limit of 10000';
        const error = classifyLogError(message);
        throw error;
      }
      const perBlock = opts.logsPerBlock ?? 0;
      const logs: RawLog[] = [];
      for (let b = from; b <= to && logs.length < perBlock * (to - from + 1); b += 1) {
        for (let i = 0; i < perBlock; i += 1) {
          logs.push({
            address: '0xf4fc',
            topics: ['0xtopic'],
            data: '0x',
            blockNumber: `0x${b.toString(16)}`,
            transactionHash: `0x${b}`,
            logIndex: `0x${i}`,
          });
        }
      }
      return logs as unknown as T;
    },
  };
  return { rpc, calls };
}

describe('getLogsChunked', () => {
  it("divise la fenêtre jusqu'à ce que le nœud accepte", async () => {
    const { rpc, calls } = fakeNode({ maxSpan: 1_000 });
    const result = await getLogsChunked(
      rpc,
      { topics: [] },
      {
        fromBlock: 0,
        toBlock: 8_000,
        initialSpan: 8_000,
        minSpan: 500,
      },
    );
    expect(result.logs).toEqual([]);
    // La première tentative est trop large, les suivantes rétrécissent.
    expect(calls[0]!.to - calls[0]!.from + 1).toBe(8_000);
    expect(calls.some((c) => c.to - c.from + 1 <= 1_000)).toBe(true);
  });

  it('réagit au timeout exactement comme au dépassement de limite', async () => {
    const { rpc, calls } = fakeNode({ maxSpan: 1_000, failWith: 'log query timed out' });
    await getLogsChunked(
      rpc,
      { topics: [] },
      {
        fromBlock: 0,
        toBlock: 4_000,
        initialSpan: 4_000,
        minSpan: 500,
      },
    );
    expect(calls.length).toBeGreaterThan(1);
  });

  it('abandonne et signale la troncature si même la fenêtre minimale est refusée', async () => {
    const { rpc } = fakeNode({ maxSpan: 10 });
    const result = await getLogsChunked(
      rpc,
      { topics: [] },
      {
        fromBlock: 0,
        toBlock: 100_000,
        initialSpan: 100_000,
        minSpan: 1_000,
      },
    );
    expect(result.truncated).toBe(true);
  });

  it('rend les logs en ordre chronologique malgré un parcours à rebours', async () => {
    const { rpc } = fakeNode({ maxSpan: 100, logsPerBlock: 1 });
    const result = await getLogsChunked(
      rpc,
      { topics: [] },
      {
        fromBlock: 1,
        toBlock: 300,
        initialSpan: 100,
        minSpan: 10,
        maxLogs: 1_000,
      },
    );
    const blocks = result.logs.map((l) => Number(l.blockNumber));
    expect(blocks).toEqual([...blocks].sort((a, b) => a - b));
  });

  it("s'arrête au plafond de logs et le signale", async () => {
    const { rpc } = fakeNode({ maxSpan: 1_000, logsPerBlock: 2 });
    const result = await getLogsChunked(
      rpc,
      { topics: [] },
      {
        fromBlock: 0,
        toBlock: 10_000,
        initialSpan: 1_000,
        maxLogs: 50,
      },
    );
    expect(result.logs).toHaveLength(50);
    expect(result.truncated).toBe(true);
  });

  it("laisse remonter une erreur qui n'est pas un refus de fenêtre", async () => {
    const rpc: RpcClient = {
      async call(): Promise<never> {
        throw new Error('panne réseau');
      },
    };
    await expect(
      getLogsChunked(rpc, { topics: [] }, { fromBlock: 0, toBlock: 10 }),
    ).rejects.toThrow(/panne réseau/);
  });
});

describe('constantes', () => {
  it('chain ID vérifié en direct', () => {
    expect(ROBINHOOD_CHAIN_ID).toBe(4663);
  });
});
