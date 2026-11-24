# Market zone recordings (Solana)

Recorded on mainnet on 24-25/11/2026 through the public node
(`https://api.mainnet-beta.solana.com`, commitment `confirmed`) by running
`readSolanaMarket` itself with `createSolanaRpc({ record })`: each
`<slug>.json` holds exactly the calls that read made, and
`dexscreener/<slug>.json` the DexScreener answer
(`/token-pairs/v1/solana/<mint>`) it read. Young tokens move: a test reads the
fixture, never the chain.

| Slug                | Mint                                           | What it shows                                                                         |
| ------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------- |
| `pump-curve-xmr`    | `ANDLpP3C7tFXEpqRBmmnbS4usmQthHfs93N5oHGpump`  | pump.fun curve paired with WXMR (`quote_mint` at 83), progress from Global            |
| `pump-curve-sol`    | `FB5eSv7CAMWJnrH5GvHLivx9y8Qgoo8vpPV3EX5Npump` | pump.fun curve on SOL                                                                 |
| `pump-graduated`    | `B34nXKzCgsJb9ChLuSHPRpXLE3WFSWyeT8Cqkzzmpump` | curve complete, PumpSwap pool `DjbLtX1H…` derived and read, LP supply 0: all burned   |
| `pump-raydium-era`  | `CzLSujWBLFsSjncfkh59rUFqvafWcY5tzedWJSuypump` | GOAT: 150-byte curve, complete, no PumpSwap pool; Raydium AMM v4 `9Tb2ohu5…` LP 99.7 % burned |
| `dbc-curve`         | `8xKZ1yzPFGG1hfsqwPR2tGWsSMx9rJWQGJKiYjKUCLRx` | Meteora DBC pool `DbdgjtiiR…` and its config: SOL raised against the threshold        |
| `dbc-migrated-sol`  | `8X6SyaSgYdPfmZTc1B7Kc7YytMwUYJVTWXgSxJWMBAGS` | DBC (bags) migrated, DAMM v2 `BjoLhkUZ…` found by its creator, 100 % permanent lock   |
| `dbc-migrated-usdc` | `Ax5dAamJPeuaLpFUzs9FdcpoUhHDcxyjPzxCJQidjups` | DBC on USDC (Jupiter studio) migrated, DAMM v2 `CP222Ubb…` 99.07 % locked, 8 positions |
| `launchlab-amm`     | `CDBdbNqmrLu1PcgjrFG52yxg71QnFhBZcUE6PSFdbonk` | LaunchLab status 2, migrate type 0: AMM v4 `Hv1i8Wrx…`, LP 99.97 % burned             |
| `launchlab-cpmm`    | `B4aJyVCibxP1J95RccZ57DPJWEfkkzUDbm9DuFD9bonk` | LaunchLab migrate type 1: CPMM `CuAr9cYg…`, LP 73.2 % burned, 26.8 % in Burn & Earn   |
| `launchlab-curve`   | `FnYLY1FQqbfNiMdDpedMPwpKWdM8RtAkwWBvWYNAwq4T` | young LaunchLab pool against another quote token, found by a program scan; no pair    |
| `ray`               | `4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R` | no launchpad; RAY/USDC and RAY/SOL AMM v4 LP held by their holders                    |

Also:

- `creations.json`: the creation transactions of `8xKZ1yzP…` (DBC
  `initialize_virtual_pool_with_spl_token`, its oldest signature) and of
  `FnYLY1FQ…` (LaunchLab `initialize_with_token_2022`, a version-1
  transaction). pump.fun's `create_v2` is in `../reference/pump-curve.json`.
- `largest-owner.json`: the owner of `FGHBr5hq…`, the only account holding the
  LP of `Hv1i8Wrx…` (getProgramAccounts on SPL Token, memcmp on the LP mint,
  24/11/2026), and that LP mint. The public node refuses
  `getTokenLargestAccounts`; the test that exercises it states its answer from
  that scan.

## What the reads taught

- **DexScreener lists a curve as the pair** (dexId `pumpfun`, `meteoradbc`,
  `bags`) with no liquidity figure.
- **pump.fun curves can be paired with other tokens** (WXMR, SPCX…): the quote
  mint is on the curve; the PumpSwap pool of `migrate_v2` uses it as a seed.
- **A LaunchLab platform config does not always name the CPMM config its pools
  used** (letsbonk.fun names `Gtdipq…`, `CuAr9cYg…` was created with `D4FPEr…`):
  the destination is looked up by its pair instead.
- **Scanning every LP account is not an option**: RAY/USDC's LP scan answered
  20 MB. Locks are read from derived accounts; holders through
  `getTokenLargestAccounts` on a keyed node.
- **The public node rate-limits program scans** (429, `Retry-After: 10`) after
  a few in a row.
