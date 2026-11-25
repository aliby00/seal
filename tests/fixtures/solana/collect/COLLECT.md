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
