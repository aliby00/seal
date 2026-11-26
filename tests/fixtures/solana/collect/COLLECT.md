# End-to-end collection recordings (Solana)

Recorded on mainnet on 25/11/2026 through the public node
(`https://api.mainnet-beta.solana.com`, commitment `confirmed`) by running
`collect` itself: `SEAL_RECORD=1 pnpm vitest run tests/collect/record.live.test.ts`
(`-t <slug>` for one token). Each `<slug>.json.gz` holds every Solana call the
collection made, every DexScreener answer it read, the clock it ran at and
the report it produced. `tests/collect/collect.test.ts` replays them through
the fake node and a fake `fetch` and expects the same report.

While recording, calls go one at a time (the public node refuses bursts of
`getTransaction` for 10 s), every reader's time limit is lifted so that only
the call caps end a read, and a call asked twice gets its first answer, so
the recording is one snapshot whatever the order the readers asked in.

| Slug                | Mint                                           | What it shows                                                                                                              |
| ------------------- | ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `pump-creator-sold` | `FB5eSv7CAMWJnrH5GvHLivx9y8Qgoo8vpPV3EX5Npump` | pump.fun curve; creator named by the curve, bought at launch, sold                                                         |
| `meteora-dbc`       | `8xKZ1yzPFGG1hfsqwPR2tGWsSMx9rJWQGJKiYjKUCLRx` | Meteora DBC pool; creator from the creation transaction; no pool yet                                                       |
| `pyusd`             | `2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo` | Token-2022 with nine powers; no launchpad; history too long to reach its creation; holders not listable on the public node |

Young tokens move: a test reads the recording, never the chain.

The report's top-level `completeness` of `pump-creator-sold` and `meteora-dbc`
was set to `full` by hand on 25/11/2026, when a curve read on chain stopped
counting DexScreener's missing liquidity figure as a gap (`marketCompleteness`
in `src/lib/collect.ts`); every other field is as recorded.

On 26/11/2026 the reports were regenerated from their own recordings (no new
call to the chain) after fields were added: `creatorOnToken.data.provided`,
`withdrawn`, `shareBase` and `saleSize`, `creatorHistory.data.scanned.pumpCurves`,
`market.data.perTradeUsd24h`, `liquidityToMarketCap` and `curveLiquidityUsd`.
The creator's moves on `meteora-dbc` are now shares of the 1e15 units minted
(burned since), not of today's supply. `pyusd.json.gz` gained the two calls
of `launchpadCreator` (LaunchLab pools, DBC scan), recorded on mainnet that day.
