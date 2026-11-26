# Audit of 26/11/2026: the transactions behind each factual error

Recorded on mainnet on 26/11/2026 through the public node
(`https://api.mainnet-beta.solana.com`, commitment `confirmed`): each file
is a recorded call (`{ method, params, result }`) or a list of them, the
shape `createSolanaRpc({ record })` gives. `tests/solana/faits-lancement.test.ts`
reads them; no test reaches the chain.

| File                                                  | Token                      | What it shows                                                                                                                        |
| ----------------------------------------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `giga-mint.json`                                      | GIGA `63LfDm…cqj9`         | `36FKPvWD…`: the whole supply (1e15) minted to the creator `9zMg9p…`; 9.6e14 today                                                   |
| `giga-initialize2.json`                               | GIGA                       | `5Td2rKaX…`: Raydium AMM v4 `initialize2` (tag 1), 87.5 % and 15 SOL into the pool, creator −15.73 SOL                               |
| `giga-exodus-buy.json`                                | GIGA                       | `5DzmULTz…`: `ExodusMet…` buys 58.3 % for 30 wrapped SOL in the pool's first second (+298 s after the mint)                          |
| `giga-launch.json`                                    | GIGA                       | every call of `replayLaunch` from the creation (60 transactions, 7 refused for rate); `getBlock 239901919` was skipped (-32007)      |
| `nest-seed.json`                                      | NEST `68Nq68…Yj6D`         | `VCciyf8H…`: Meteora DAMM v2 `initialize_customizable_pool`, 40 % of the supply one-sided from the creator                           |
| `fakesol-clmm.json`                                   | "SOL" `6Dyz9e…K52G`        | `4TpKiF…`: Raydium CLMM `create_customizable_pool_v2` + `open_position_with_token22_nft`, 99.99 % deposited                          |
| `popcat-sell.json`                                    | POPCAT `7GCihg…W2hr`       | `5CdhWtCP…`: Meteora DAMM v1 `initialize_permissionless_pool_with_fee_tier`, read as a sale of "0.0191 SOL"                          |
| `gondola-creation.json`                               | Gondola `5vQGwx…pump`      | `5B86…`: pump.fun `create_v2` signed by `3vxCYSy3…` and the mint; the curve names `3cZgqs…`; `3vxC` gets 21.46 %                     |
| `hoss-creation.json`                                  | hoss `EvTaKH…pump`         | `58ijCk…`: signed by `8ZRL2vNX…`, who gets 6.63 %; the curve names `E33nfq…`                                                         |
| `pcb-first.json`                                      | PCB `PpYYE5…NX6r`          | `5ShYRK…`: the mint's oldest transaction, program `DrAskgJ3…`, signed by `6eCJmA…` and the mint's key, no mint initialised           |
| `sidoor-dbc.json`, `ember-dbc.json`, `rings-dbc.json` | SIDOOR, EMBER, Rings       | their Meteora DBC `VirtualPool` (424 bytes): `creator` at 104, `base_mint` at 136                                                    |
| `lendr-launchlab.json`                                | LENDR `AGazYi…Lend`        | its LaunchLab `PoolState` (429 bytes): `base_mint` at 205, `creator` at 333                                                          |
| `launchpad-pools.json`                                | USDC, PYUSD, SIDOOR, LENDR | the calls of `launchpadCreator`: LaunchLab pools at their derived addresses, then a DBC scan on the mint                             |
| `dex-ember.json`, `dex-link.json`                     | EMBER, LINK                | DexScreener `/token-pairs/v1/solana/<mint>`: EMBER's $64.6k pool against MET; LINK's PumpSwap pool against NEURALINK, no USD figures |
