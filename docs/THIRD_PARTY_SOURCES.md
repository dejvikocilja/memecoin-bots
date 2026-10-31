# Discovery protocol sources

BOT-6 contains selected factual wire-schema fragments: program addresses, instruction/event
names, discriminators, field names/types, and account positions. The decoder is an independent
implementation; upstream program implementations and SDKs are not bundled. Public-chain
replay fixtures contain public transaction data. The exact source revisions, paths, URLs and
SHA-256 hashes are recorded in `apps/engine/src/market-data/schemas.json`.

| Source                     | Attribution / upstream license information                                                                                              |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| pump-fun/pump-public-docs  | Pump protocol public IDLs; upstream repository does not state a license in the checked source tree. No license is inferred.             |
| MeteoraAg/dlmm-sdk         | Meteora DLMM public IDL; package declares ISC.                                                                                          |
| MeteoraAg/cp-amm-sdk       | Copyright (c) 2026 Meteora. MIT; original notice and license retained in `licenses/METEORA-CP-AMM-MIT.txt`.                             |
| MeteoraAg/dynamic-amm-sdk  | Meteora DAMM v1 public IDL; package declares MIT, with no repository license file in the checked tree. No copyright notice is invented. |
| raydium-io/raydium-cp-swap | Raydium CPMM wire facts; Apache License 2.0.                                                                                            |
| raydium-io/raydium-clmm    | Raydium CLMM wire facts; Apache License 2.0.                                                                                            |
| raydium-io/raydium-amm     | Raydium AMM v4 wire facts; Apache License 2.0.                                                                                          |

The Raydium repositories carry the same Apache License 2.0 text, retained in
`licenses/RAYDIUM-APACHE-2.0.txt`. No endorsement by these projects is implied.
