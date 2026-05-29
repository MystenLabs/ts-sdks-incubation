---
'@mysten-incubation/devstack': minor
---

Fork mode: impersonation-based faucet + setup/usability fixes.

- **Fork faucet** — `sui({ mode: 'fork', faucet: { whale, perRequestCapMist?, enabled? } })` funds test
  accounts by impersonating a large-reserve "whale" address on the forked upstream and transferring SUI
  from it. Wired through the existing faucet-strategy pathway, so ephemeral-account auto-funding and
  cross-cutting SUI funding work in fork mode exactly like localnet. The whale is auto-seeded into fork
  state and its largest SUI coin is validated at boot. `scripts/find-fork-whale.mjs` helps source one.
- **Error surfacing** — `formatUnknownError` now unwraps a tagged error's `.message` and chains its
  `.cause`, and the publish / action / wallet / sui-execute transaction paths route through it. Fixes
  `account.signAndExecute failed … [object Object]`, which had swallowed the real cause (e.g.
  "no SUI gas coins found for 0x…").
- **Image build UX** — the first-run `sui-fork` source build now narrates progress on the supervisor
  row instead of appearing hung; `image: { pull }` or `DEVSTACK_SUI_FORK_IMAGE` skip the build with a
  prebuilt image, falling back to a source build on miss.
- **Fork-mode real accounts** — faucet-funded *real* (ephemeral) accounts can now publish and run
  actions in fork mode, not just impersonate accounts. Two pieces: (1) funding-settlement balance reads
  use `listCoins` in fork mode, since `getBalance`/`listBalances` panic under the fork guard; (2) the
  publish and action transaction paths build offline with explicit gas in fork mode (real signers too,
  not only impersonate), because the `sui-fork` binary has no `simulate_transaction` for the SDK's
  gas-estimating build. End-to-end: a fork stack of ephemeral accounts auto-funds and publishes a Move
  package with no pre-funded addresses.
- **Readiness** — the fork ready-probe timeout message now points at the container logs and the
  `readyTimeout` option.

Follow-up: publish a prebuilt `sui-fork` image in CI (e.g. `ghcr.io/mysten/sui-fork:<rev>`) so the
default path pulls in seconds instead of compiling from source.
