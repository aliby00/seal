/**
 * Every threshold the flags are drawn with, in one place. A flag judges one
 * fact (red, orange or green), never the token: there is no total, no score
 * and no word for the whole. Calibrated on the 36 tokens production read on
 * 26/11/2026 (fresh pump.fun launches to POPCAT, GIGA, RAY), so that a fresh
 * launch whose dev dumped comes out red where it did, and a two-year-old
 * token with burned LP and deep liquidity does not.
 */
export const FLAG_RULES = {
  /** The dev sold at least this part of what it bought or got: red. Less: orange. */
  devSoldRed: 0.5,
  /** A dev share worth a line at all (bought, held, sold), of the supply. */
  devMin: 0.01,
  /** The dev holds this much of the supply, outside locks and pools: red / orange. */
  devHoldsRed: 0.2,
  devHoldsOrange: 0.05,
  /** Wallets that got tokens together (creation slot, one transaction, dev-paid): red / orange. */
  bundleRed: 0.2,
  bundleOrange: 0.05,
  /** The first seconds' buyers, all together: red / orange. */
  snipersRed: 0.5,
  snipersOrange: 0.15,
  /** A group still holding this much of the supply turns red whatever it got. */
  stillHeldRed: 0.05,
  /** Other launches by the dev that make a serial launcher (orange), and red past this many. */
  serialOrange: 10,
  serialRed: 100,
  /** Part of the dev's checked launches dead (no market, or a cap under the floor) to say "mostly dead". */
  mostlyDead: 0.7,
  /** A few other launches still count when this share of them is dead: orange. */
  fewLaunchesMin: 3,
  /** Market cap under this after volume this many times larger: the chart is dead (red). */
  deadMcapUsd: 5_000,
  deadVolumeFactor: 10,
  /** Fading: market cap under this with volume this many times larger: orange. */
  fadingMcapUsd: 25_000,
  fadingVolumeFactor: 5,
  /** Liquidity over market cap, outside a bonding curve: red under, orange under, green from. */
  liquidityRed: 0.05,
  liquidityOrange: 0.1,
  liquidityGreenMinMcapUsd: 50_000,
  /** From this market cap, a pool of a few percent is deep in dollars (POPCAT: $2.3M, 8.5%): red / orange under. */
  largeCapUsd: 5_000_000,
  largeCapLiquidityRed: 0.02,
  largeCapLiquidityOrange: 0.05,
  /** A pool this empty moves on a few hundred dollars: red. */
  emptyPoolUsd: 1_000,
  /** Top 10 wallets of the whole supply (pools, curves, locks out): red / orange / green under. */
  top10Red: 0.5,
  top10Orange: 0.3,
  top10Green: 0.15,
  top10GreenMinHolders: 100,
  /** One wallet of the whole supply: red / orange. */
  top1Red: 0.2,
  top1Orange: 0.1,
  /** Ten wallets within this ratio of one another, holding this much together: a cluster (red). */
  equalBagsRatio: 0.75,
  equalBagsMin: 0.1,
  /** LP burned or locked for good, of the main pool: green; withdrawable from: red. */
  lpGreen: 0.95,
  lpWithdrawableRed: 0.5,
  /** Wallets the dev sent SOL to that bought this much: orange. */
  linkedOrange: 0.01,
  /** No trade for this many hours: orange. */
  quietHours: 1,
  /** Lines of red and orange shown, at most; the greens share one line. */
  maxLines: 5,
} as const;
