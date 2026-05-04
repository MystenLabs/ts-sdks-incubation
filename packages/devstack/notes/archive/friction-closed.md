# Friction journal — closed entries (archive)

Archived from `notes/friction.md` when round 4 closed. Each line is one
piece of friction that was actively painful at some point and is now
fixed. Kept for git-blame-style reference; the live journal at
`notes/friction.md` only tracks what's still open or pending.

| Entry                                                                  | Closed by                                                                                                     |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Hardcoded ports across plugin instantiations                           | PR 8 (per-stack port allocator)                                                                               |
| wallet-server manifest race on cold-first-run                          | PR 9 (Register/Serve split)                                                                                   |
| Faucet 500 on cold-first-bring-up                                      | `keys.ts:64` retry-with-backoff                                                                               |
| Playwright `defineDevstackPlaywrightConfig` baseURL hardcoded          | PR 16 (extend.webServer/use shallow merge)                                                                    |
| Reconciler runs same-signer transactions in parallel                   | PR 17 (`runsAs` soft constraint)                                                                              |
| Walrus subnet hardcoded at `10.0.0.0/24` blocks per-stack siblings     | PR 23 (per-(app, stack) octet + sed-patch deploy script)                                                      |
| Same-account signer used by both supervisor + browser path equivocates | PR 31 (interim `mm` workaround) → PR 33+34+35 (address-balance funding; SDK auto-picks `payment: []` AB-mode) |
