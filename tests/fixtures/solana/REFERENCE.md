# Solana reference tokens

Read on mainnet on 24/11/2026 through the public node
(`https://api.mainnet-beta.solana.com`, commitment `confirmed`). The details
of what was checked for each are in `REFERENCE.json`; the recorded answers are
in `reference/<slug>.json` and replay through the fake node
(`src/lib/solana/fake-rpc.ts`, `tests/solana/fixtures.ts`).

Young tokens move: the fixtures are a snapshot. A test reads the fixture, never
the chain.

| Slug                | Mint                                           | Why it is here                                                       |
| ------------------- | ---------------------------------------------- | -------------------------------------------------------------------- |
| `pump-curve`        | `ANDLpP3C7tFXEpqRBmmnbS4usmQthHfs93N5oHGpump`  | pump.fun, about 2 hours old, still on its curve (`complete` = 0)     |
| `pump-graduated`    | `B34nXKzCgsJb9ChLuSHPRpXLE3WFSWyeT8Cqkzzmpump` | pump.fun, graduated: curve `complete` = 1, PumpSwap pool `DjbLtX1H…` |
| `meteora-dbc`       | `8xKZ1yzPFGG1hfsqwPR2tGWsSMx9rJWQGJKiYjKUCLRx` | Meteora Dynamic Bonding Curve pool `DbdgjtiiR…`                      |
| `raydium-old`       | `4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R` | RAY, Raydium AMM v4 pool `AVs9TA4n…` since 2022                      |
| `pyusd`             | `2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo` | Token-2022: permanent delegate, transfer hook, close authority…      |
| `bern`              | `CKfatsPMUf8SkiURsDXs7eK6GWb4Jsd6UDbs7twMCWxo` | Token-2022 transfer fee, 269 bps                                     |
| `usdc`              | `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` | Mint and freeze authorities kept                                     |
| `pump-bundled`      | `6qmoWWfCw1uVMfPzRWkCEu4kLmT9F8d3MXDMexXkpump` | 4 other wallets bought in the creation slot (one took 35 %)          |
| `pump-creator-sold` | `FB5eSv7CAMWJnrH5GvHLivx9y8Qgoo8vpPV3EX5Npump` | Creator bought 11.9 % at launch, sold it all in one transaction      |
| `many-holders`      | `CzLSujWBLFsSjncfkh59rUFqvafWcY5tzedWJSuypump` | GOAT: 76,652 token accounts with a balance                           |
| `bonk`              | `DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263` | Known token                                                          |
| `jup`               | `JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN`  | Known token                                                          |

## What the reads taught

- **The creator is on the curve, not the fee payer.** `pump-curve` was created
  by a transaction signed by `F46pqf6c…`; the curve names `B7VKZzqy…`.
- **Holders are not always on associated token accounts.** In the creation slot
  of `pump-bundled`, four buyers used token accounts that are not their ATAs.
  Read a holder from the token account's `owner`, never derive it back.
- **New pump.fun mints are Token-2022** with `metadataPointer` + `tokenMetadata`
  and no authority (24 of 24 young pump.fun mints read that day); GOAT, older, is an SPL Token mint.
- **u64 in jsonParsed lose precision.** BERN's `maximumFee` is
  3906250000000000000, beyond 2^53.
- **The public node** refuses `getTokenLargestAccounts` (429, `Retry-After: 10`,
  every time) but answers `getProgramAccounts` on a mint with 249,243 token
  accounts in 2.7 s with an 8-byte `dataSlice`.
- **Version-1 transactions** were 222 of the 442 transactions of the recent blocks read
  that day; asked without `maxSupportedTransactionVersion: 1` the node refuses
  them (-32015). `rpc/v1-transaction.json` is one of them.
