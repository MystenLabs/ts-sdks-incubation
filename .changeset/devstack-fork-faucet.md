---
'@mysten-incubation/devstack': minor
---

Fork mode: impersonation-based faucet + setup/usability fixes.

- **Fork faucet** — `sui({ mode: 'fork', faucet: { whale, perRequestCapMist?, enabled? } })` funds test
  accounts by impersonating a large-reserve "whale" address on the forked upstream and transferring SUI
  from it. Wired through the existing faucet-strategy pathway, so ephemeral-account auto-funding and
  cross-cutting SUI funding work in fork mode exactly like localnet. The whale is auto-seeded into fork
  state and validated at boot to hold a SUI coin covering a default fund plus gas (an actionable error
  fires if none qualifies). Coin selection paginates the whale's coins and uses the first that covers
  the request + gas budget, so a sufficient coin sitting behind dust on a later page is still found.
- **Error surfacing** — `formatUnknownError` now unwraps an error's `.message` (tagged plain objects
  included, not just `Error`s) and chains its `.cause` (whether that cause is an `Error` or a tagged
  object), and the publish / action / wallet / sui-execute transaction paths route through it. Fixes
  `account.signAndExecute failed … [object Object]`, which had swallowed the real cause (e.g.
  "no SUI gas coins found for 0x…").
- **Image build UX** — the first-run `sui-fork` source build now narrates progress on the supervisor
  row instead of appearing hung; `image: { pull }` or `DEVSTACK_SUI_FORK_IMAGE` skip the build with a
  prebuilt image, falling back to a source build on miss.
- **Fork-mode real accounts** — faucet-funded *real* (ephemeral) accounts can now publish, run actions,
  mint coins, AND move value in fork mode, not just impersonate accounts. Pieces: (1) funding-settlement
  balance reads use `listCoins` in fork mode, since `getBalance`/`listBalances` panic under the fork
  guard; (2) the publish, action, and coin-mint transaction paths build offline with explicit gas in
  fork mode (real signers too, not only impersonate), because the `sui-fork` binary has no
  `simulate_transaction`; (3) the fork gas budget is lowered to 0.1 SUI so a faucet-funded account's
  coin isn't fully reserved by gas — leaving headroom to split/transfer value. End-to-end verified: a
  fork stack of ephemeral accounts auto-funds, publishes a Move package, and runs a value-transfer
  action with no pre-funded addresses. (Deepbook pool deploy + its DEEP-funding faucet remain
  local/known-only in fork — out of scope here.)
- **Readiness** — the fork ready-probe timeout message now points at the container logs and the
  `readyTimeout` option.

Follow-up: publish a prebuilt `sui-fork` image in CI (e.g. `ghcr.io/mysten/sui-fork:<rev>`) so the
default path pulls in seconds instead of compiling from source.
