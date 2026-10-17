import type { Db } from './db.ts';

/**
 * Les statistiques d'échange d'un token, calculées à la demande depuis les
 * swaps stockés. Un seul parcours des swaps du token, dans l'ordre du temps :
 * pas de tableau intermédiaire, les montants restent des `bigint`.
 *
 * Le trader est le signataire de la transaction (`origin`) ; à défaut, le
 * destinataire du swap. `sender` est presque toujours un routeur.
 */
export type WindowStats = {
  buys: number;
  sells: number;
  uniqueTraders: number;
  /** Montant échangé côté token de paire (le plus souvent WETH), en wei. */
  volume: string;
  /** ISO 8601. */
  lastTradeAt: string | null;
};

export type TraderStats = {
  address: string;
  buys: number;
  sells: number;
  /** Volume côté token de paire, en wei. */
  volume: string;
  /** Tokens achetés moins tokens vendus, en unités brutes (signé). */
  netToken: string;
  isCreator: boolean;
};

export type TokenStats = {
  windows: { h1: WindowStats; h24: WindowStats; d7: WindowStats; sinceLaunch: WindowStats };
  topTraders7d: TraderStats[];
  creator: { traded: boolean; buys: number; sells: number };
};

const WINDOWS = { h1: 3_600, h24: 86_400, d7: 7 * 86_400 } as const;

type Acc = {
  buys: number;
  sells: number;
  traders: Set<string>;
  volume: bigint;
  last: number | null;
};

const empty = (): Acc => ({ buys: 0, sells: 0, traders: new Set(), volume: 0n, last: null });

const abs = (x: bigint): bigint => (x < 0n ? -x : x);

function close(acc: Acc): WindowStats {
  return {
    buys: acc.buys,
    sells: acc.sells,
    uniqueTraders: acc.traders.size,
    volume: acc.volume.toString(),
    lastTradeAt: acc.last === null ? null : new Date(acc.last * 1000).toISOString(),
  };
}

export function tokenStats(
  db: Db,
  token: string,
  options: { creator: string; tokenIsToken0: boolean; nowSec: number; top?: number },
): TokenStats {
  const accs = { h1: empty(), h24: empty(), d7: empty(), sinceLaunch: empty() };
  const traders = new Map<string, { buys: number; sells: number; volume: bigint; net: bigint }>();
  const creator = { traded: false, buys: 0, sells: 0 };
  const rows = db.raw
    .prepare(
      `SELECT ts, side, amount0, amount1, COALESCE(origin, recipient) AS trader, recipient
       FROM swaps WHERE token = ? ORDER BY ts`,
    )
    .iterate(token) as Iterable<{
    ts: number;
    side: 'buy' | 'sell';
    amount0: string;
    amount1: string;
    trader: string;
    recipient: string;
  }>;

  for (const row of rows) {
    const a0 = BigInt(row.amount0);
    const a1 = BigInt(row.amount1);
    const pair = abs(options.tokenIsToken0 ? a1 : a0);
    const amount = abs(options.tokenIsToken0 ? a0 : a1);
    const age = options.nowSec - row.ts;
    const add = (acc: Acc) => {
      if (row.side === 'buy') acc.buys += 1;
      else acc.sells += 1;
      acc.traders.add(row.trader);
      acc.volume += pair;
      acc.last = row.ts;
    };
    add(accs.sinceLaunch);
    if (age <= WINDOWS.d7) {
      add(accs.d7);
      const t = traders.get(row.trader) ?? { buys: 0, sells: 0, volume: 0n, net: 0n };
      if (row.side === 'buy') {
        t.buys += 1;
        t.net += amount;
      } else {
        t.sells += 1;
        t.net -= amount;
      }
      t.volume += pair;
      traders.set(row.trader, t);
    }
    if (age <= WINDOWS.h24) add(accs.h24);
    if (age <= WINDOWS.h1) add(accs.h1);
    if (row.trader === options.creator || row.recipient === options.creator) {
      creator.traded = true;
      if (row.side === 'buy') creator.buys += 1;
      else creator.sells += 1;
    }
  }

  const topTraders7d = [...traders.entries()]
    .sort((a, b) => (b[1].volume > a[1].volume ? 1 : b[1].volume < a[1].volume ? -1 : 0))
    .slice(0, options.top ?? 5)
    .map(([address, t]) => ({
      address,
      buys: t.buys,
      sells: t.sells,
      volume: t.volume.toString(),
      netToken: t.net.toString(),
      isCreator: address === options.creator,
    }));

  return {
    windows: {
      h1: close(accs.h1),
      h24: close(accs.h24),
      d7: close(accs.d7),
      sinceLaunch: close(accs.sinceLaunch),
    },
    topTraders7d,
    creator,
  };
}
