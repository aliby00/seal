/**
 * Tokens whose main pool the live price is recorded for: pump.fun curves and
 * PumpSwap pools, read on chain; Raydium and Meteora pools, not read (their
 * DexScreener figures stay).
 */
export const LIVE_PRICE_TOKENS = [
  // pump.fun curve, under an hour old when recorded.
  { slug: 'pump-curve', mint: '6ppi7LfHkAhHkQwS3kT1zjCsGYQyK4uvpp3pE6Xmpump' },
  // PumpSwap, graduated minutes before.
  { slug: 'pumpswap-young', mint: '8XefdyFEBBLwvEWpGZqLmBDR9TmDeon1aLy16x2ipump' },
  { slug: 'pumpswap-ansem', mint: '9cRCn9rGT8V2imeM2BaKs13yhMEais3ruM3rPvTGpump' },
  // Not read here: DexScreener's figures stay.
  { slug: 'raydium-amm-v4', mint: '63LfDmNb3MQ8mw9MtZ2To9bEA2M71kZUUGq5tiJxcqj9' },
  { slug: 'raydium-cpmm', mint: 'GPiHbgbvWbZHKQiVf1v8AupAuST3mqSv3zb2SBJULGND' },
  { slug: 'damm-v2-sol', mint: '65iH8k736QNhuUHm1tt8X7yJXpJ517HPPq8BrVdwring' },
  { slug: 'damm-v2-usdc', mint: 'PpYYE5KdVWc2r5W7RsvVA3Lcs4PLBkASxGVZGbmNX6r' },
  { slug: 'dlmm', mint: '6p6xgHyF7AeE6TZkSmFsko444wqoP15icUSqi2jfGiPN' },
] as const;

export type LivePriceCase = {
  slug: string;
  mint: string;
  pool: string;
  dex: string;
  now: string;
  kind: string | null;
  dexscreener: {
    priceUsd: number;
    priceNative: number;
    liquidityUsd: number | null;
    marketCapUsd: number | null;
  };
};
