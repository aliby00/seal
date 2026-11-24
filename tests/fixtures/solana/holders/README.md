# Holders fixtures

Answers of the public node (`https://api.mainnet-beta.solana.com`, commitment
`confirmed`) recorded through `createSolanaRpc({ record })` while
`readHolders` (`src/lib/solana/holders.ts`) read each token, on 24-25/11/2026
around 00:08 UTC. They replay through the fake node
(`tests/solana/holders.test.ts`, `tests/solana/holders-roles.test.ts`).

| File                          | Mint                                           | What it shows                                                                      |
| ----------------------------- | ---------------------------------------------- | ---------------------------------------------------------------------------------- |
| `pump-curve.json`             | `ANDLpP3C7tFXEpqRBmmnbS4usmQthHfs93N5oHGpump`  | pump.fun curve `8j8apXSG…` holding 96.29 %; 160 accounts, 13 holders               |
| `meteora-dbc.json`            | `8xKZ1yzPFGG1hfsqwPR2tGWsSMx9rJWQGJKiYjKUCLRx` | Meteora DBC authority 37.63 %, a Streamflow escrow 3.18 %                          |
| `jup-lock.json`               | `2gmnGtsLYHdttFCn4jVpRFbsNPgHfNkgPh2mGFmopump` | Five Jupiter Lock escrows (94.97 %), a PumpSwap pool, an unknown program owner     |
| `streamflow.json`             | `4iNowernM7VnmA79FyedcUGnM22GMm2keEtwbaJepump` | Raydium AMM v4 (81.10 %) and CLMM pools, a Streamflow escrow, a pump.fun curve     |
| `launchlab.json`              | `8tLjXE3MRduPL3qZcFZ4k2Covpuk6Zax4A1aqDTfLoat` | Raydium LaunchLab authority 99.97 %; 4 accounts                                    |
| `burn.json`                   | `8YbE2LfQJmUYVw9Uhdy5EC53iuUNV7qfQq8naiGiGgan` | Incinerator 43.96 %, a Meteora DAMM v2 pool, a Meteora DBC curve                   |
| `many-holders.json`           | `CzLSujWBLFsSjncfkh59rUFqvafWcY5tzedWJSuypump` | GOAT: the sample of owners starting with a zero byte (1,020 accounts)              |
| `pools.json`                  | —                                              | Nine pools of nine venues and one vault of each                                    |
| `edge.json`                   | —                                              | No account at the incinerator; a PumpSwap pool read as a mint                      |
| `public-refuses-largest.json` | —                                              | The public node's answer to `getTokenLargestAccounts`: HTTP 429, `Retry-After: 10` |

## Two answers that are not the node's

The public node refuses `getTokenLargestAccounts` and no keyed node was at
hand, so `many-holders-largest-derived.json` and
`launchlab-largest-derived.json` were built, not recorded: from every token
account of the mint read with `getProgramAccounts` at the same time, the 20
largest by amount (all 4 for the LaunchLab token), in the shape the method
returns (https://solana.com/docs/rpc/http/gettokenlargestaccounts). What
follows them (`many-holders.json`, `launchlab-keyed.json`: the token accounts
read with `getMultipleAccounts`, their owners, the creator's accounts) is the
node's own answer.

## Checked against the full list or another source

- **GOAT, 249,244 token accounts** (read in full with `getProgramAccounts`,
  71 MB, kept out of the repository): 76,654 non-empty accounts, 76,517
  owners with a balance, 75,331 of them wallets. From its 20 largest accounts
  `readHolders` gives the largest wallet at 6.7251 %, the 10 largest wallets
  at 44.8981 % and the Raydium AMM v4 pool at 5.0304 %: the same figures as
  the full list. GeckoTerminal counts 76,660 holders (updated 24/11 10:30).
- **FIONA** (`B34nXKzCgsJb9ChLuSHPRpXLE3WFSWyeT8Cqkzzmpump`, read live, 8.7 MB
  not kept): 30,526 accounts read in full in 2.3 s, 10,804 holders besides
  its pools (PumpSwap, Meteora DLMM, Raydium CLMM); 10,841 non-empty
  accounts; GeckoTerminal 10,849.
- **Burn token**: 1,041 holders plus 3 set aside = 1,044 owners;
  GeckoTerminal 1,044 (updated 09/11).
- **Streamflow token**: 108 + 4 = 112; GeckoTerminal 115 (updated 24/11 02:37).
- **Jupiter Lock token**: 80 + 6 = 86; GeckoTerminal 84 (updated 07/11).

The figures move with the chain: these fixtures are a snapshot.
