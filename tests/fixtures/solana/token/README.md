# Token zone fixtures

Recorded on mainnet on 24/11/2026 through the public node
(`https://api.mainnet-beta.solana.com`, commitment `confirmed`) by running
`readToken` live with the real client's `record` option, then asking the node
for its jsonParsed of the same mint. Each `<slug>.json` holds those calls, in
order, and replays through the fake node (`tests/solana/token.test.ts`).

| Slug            | Address                                        | What it shows                                                                                                                            |
| --------------- | ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `pyusd`         | `2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo` | Token-2022, eight extensions, every authority held, fee 0 with an authority                                                              |
| `usdg`          | `2u1tszSeqZ3qBWF3uNGPFc8TzMk2tdiwknnRMWGWjGWH` | Paxos Global Dollar: same set of extensions as PYUSD                                                                                     |
| `usdc`          | `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` | SPL Token, mint and freeze authorities, mutable Metaplex metadata                                                                        |
| `bern`          | `CKfatsPMUf8SkiURsDXs7eK6GWb4Jsd6UDbs7twMCWxo` | Transfer fee 420 bps, then 269 bps from epoch 698; epoch read: 1096                                                                      |
| `pump-curve`    | `ANDLpP3C7tFXEpqRBmmnbS4usmQthHfs93N5oHGpump`  | pump.fun Token-2022: metadataPointer + tokenMetadata, no authority                                                                       |
| `tslax`         | `XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB`  | Tesla xStock: pausableConfig, defaultAccountState, scaledUiAmountConfig (multiplier 1)                                                   |
| `spyx`          | `XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W`  | SP500 xStock: multiplier 1.00573…, then 1.00747… from 1793454300 (31/10/2026)                                                            |
| `sgt-group`     | `GT22s89nU4iWFkNXj1Bw6uYhJJWDRPpShHt4Bk8f99Te` | Seeker Genesis Token group: groupPointer, tokenGroup (docs.solanamobile.com)                                                             |
| `sgt-member`    | `62vJ96UJHgPucPCS1wDme8Kgi3CF93uQNmoEKPveA83Z` | A member minted by GT2zuHVa… (its creation transaction): groupMemberPointer, tokenGroupMember; its metadata pointer names the group mint |
| `bonk`          | `DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263` | SPL Token, mutable Metaplex metadata                                                                                                     |
| `jup`           | `JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN`  | SPL Token, mutable Metaplex metadata                                                                                                     |
| `ray`           | `4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R` | SPL Token, mutable Metaplex metadata                                                                                                     |
| `goat`          | `CzLSujWBLFsSjncfkh59rUFqvafWcY5tzedWJSuypump` | Older pump.fun SPL mint: Metaplex `isMutable` false                                                                                      |
| `meteora-dbc`   | `8xKZ1yzPFGG1hfsqwPR2tGWsSMx9rJWQGJKiYjKUCLRx` | Metaplex `isMutable` false, update authority all zeroes                                                                                  |
| `token-account` | `33J8AEXc7aFsnNoEU8wr2qNtNGQKXzRYXaZkAM54vuN3` | Not a mint: a Token-2022 token account (PumpSwap pool vault)                                                                             |
| `program`       | `6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P`  | Not a mint: the pump.fun program                                                                                                         |
| `no-account`    | `1nc1nerator11111111111111111111111111111111`  | No account at all                                                                                                                        |

Recorded on 25/11/2026 the same way, for `tests/solana/token-edge.test.ts`:

| Slug                | Address                                        | What it shows                                                                              |
| ------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `multisig-2022`     | `DRXA1H9SjZPyPCEeuAWpfwk8GqVW6dZsKFAtdfpFwApX` | Not a mint: PYUSD's mint authority, a 355-byte Token-2022 multisig (jsonParsed `multisig`) |
| `multisig-spl`      | `BJE5MMbqXjVwjAF7oxwPYXnTXDyspzZyt4vwenNw5ruG` | Not a mint: USDC's mint authority, a 355-byte SPL Token multisig                           |
| `spl-token-account` | `1yYy5Vcy5Zop8Q2cPeJhyPtGpn5G46XWMZCR4s6F4y`   | Not a mint: a 165-byte SPL Token account holding USDC (owner: Raydium AMM v4 authority)    |

No mainnet mint carrying `nonTransferable`, `interestBearingConfig`,
`confidentialMintBurn` or `permissionedBurnConfig` was found that day (the
public node refuses `getProgramAccounts` over the whole Token-2022 program:
403). Those four are decoded from the program's source only.
