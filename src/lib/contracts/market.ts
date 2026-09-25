import type { Sourced } from './completeness';

export type TxnCounts = { buys: number; sells: number };

export type MarketStateData = {
  token: string;
  pair: string | null;
  priceUsd: number | null;
  liquidityUsd: number | null;
  /** ETH immobilisé dans le pool — c'est ce que compte la graduation. */
  pairedEth: number | null;
  graduation: {
    /** Seuil en ETH. 4,2 au moment de la vérification, lu on-chain et non codé en dur. */
    thresholdEth: number;
    progress: number;
    graduated: boolean;
  } | null;
  volumeUsd: { m5: number; h1: number; h6: number; h24: number } | null;
  txns: { h1: TxnCounts; h24: TxnCounts } | null;
  fdvUsd: number | null;
  pairCreatedAt: string | null;
};

export type MarketState = Sourced<MarketStateData>;
