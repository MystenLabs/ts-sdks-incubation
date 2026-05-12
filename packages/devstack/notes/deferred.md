# Deferred work

PRs proposed during prior architecture-review rounds and deferred with
rationale. Each item is a thumb-sketch — revisit when a concrete reason
to act on one materializes. Not friction (the pain is captured already
elsewhere or doesn't exist yet); not verification (no hands-on check
owed). Pure "we decided not to do this now."

### C2 — npm publishing

`@mysten-incubation/devstack` is at `0.1.0` with public `publishConfig`
and ready to publish. Remaining gates and gotchas surfaced during a
trial run of the changeset flow:

- **Workspace-sibling ordering.** `@mysten-incubation/dev-wallet` is at
  `0.0.1` on npm and needs a `0.1.0` publish to match the local
  workspace; `@mysten-incubation/devstack-wallet-panels` and
  `@mysten-incubation/create-devstack-app` don't exist on npm yet. pnpm
  rewrites `workspace:*` on publish, so any sibling that lags will 404
  at consumer install time. All four need to land in the same release
  cycle.

- **Peer-dep cascade pushes devstack to a major bump.** `devstack`
  peer-deps `dev-wallet` and `devstack-wallet-panels` with
  `workspace:*`, which resolves to the EXACT current version on
  publish. The repo's `.changeset/config.json` enables
  `onlyUpdatePeerDependentsWhenOutOfRange: true`, so when the peers
  bump from `0.0.x → 0.1.0` the peer range goes out of range, which is
  treated as a breaking change to devstack's contract. Result: a
  `minor` changeset on `devstack` actually produces `0.0.0 → 1.0.0` (a
  major bump) instead of `0.0.0 → 0.1.0`. Three mitigations to choose
  from:
  1. Use `workspace:^` (caret-bounded) instead of `workspace:*` for
     the cross-workspace peer deps. Caret-ranges absorb minor bumps
     without going out of range.
  2. Move the cross-workspace siblings out of `peerDependencies` and
     back into `dependencies`. The earlier audit moved them to peer to
     keep CLI consumers from pulling browser-side weight; reversing
     that loses the bundle-size win for that single category of
     consumer. Probably the wrong tradeoff.
  3. Drop the `onlyUpdatePeerDependentsWhenOutOfRange` opt entirely so
     peer changes follow `updateInternalDependencies: minor` (which
     keeps cascade bumps at minor). Cleaner long-term; verify against
     changeset's docs that the opt is removable.

  Recommended fix: option 1 (`workspace:^`) before the first publish.

- **Stale changesets describe pre-rename API.** Three changesets at
  `.changeset/dev-wallet-devstack-adapter.md`,
  `.changeset/devstack-wallet-panels-init.md`, and
  `.changeset/devstack-wallet-server.md` were written against the
  pre-redesign surface (`walletServer`, `virtual:devstack-keys`,
  `createDevstackDappKit({ walletInitializers })`). The
  `devstack-wallet-server.md` one is `major` on devstack which would
  bump to `1.0.0`. Replace all three with one comprehensive
  `initial-public-release.md` changeset describing the post-rename
  surface (`walletApp` server plugin, `createDevstackDappKit({ manifest })`
  React-side, `DevstackSignerAdapter` adapter wiring, panels
  package, scaffold) with `minor` bumps across all four publishable
  packages.

- **Version baselines need resetting.** The four publishable packages
  currently carry `version: "0.1.0"` in `package.json`. For changesets
  to compute the right next-version, baselines should be:
  - `@mysten-incubation/devstack`: `0.0.0` (never published)
  - `@mysten-incubation/devstack-wallet-panels`: `0.0.0` (never published)
  - `@mysten-incubation/create-devstack-app`: `0.0.0` (never published)
  - `@mysten-incubation/dev-wallet`: `0.0.1` (matches npm)
  Then a `minor` changeset bumps each to `0.1.0` cleanly, AND devstack
  follows once option 1 above is applied (`workspace:^` keeps the peer
  cascade at minor).

- **`publishConfig.access: public`** is set on `devstack` only. The
  three siblings rely on `.changeset/config.json`'s `access: public`
  default, which works through the changesets `publish` step but isn't
  obvious to readers. Add explicit `publishConfig.access: public` to
  `dev-wallet`, `devstack-wallet-panels`, and `create-devstack-app`
  for clarity (one-line addition each).

- **Verify.** After applying the four mitigations above, run
  `pnpm changeset version` on a throwaway branch and confirm all four
  packages land at `0.1.0`. Then run `pnpm pack` per package, extract
  the bundled `package.json`, and confirm `workspace:^` rewrote to
  `^0.1.0` (concrete) in `peerDependencies`. Then merge the release
  PR; the `.github/workflows/changesets.yml` job picks it up on `main`
  push.

### E1 — `loadFixture()` for parallel e2e

Every plausible mechanism trades against a different cost: per-test
snapshot restore is ~15 s on `docker commit`-based snapshots (too slow);
per-stack-per-test means N parallel containers; in-memory revert needs a
Sui-side checkpoint API we don't have. Revisit when a specific e2e suite
is measurably bottlenecked by `mode: 'serial'`.

### E2 — Supervisor-TUI manual action triggers

Hotkeys for re-running specific actions (a debug aid for plugin
authors). Lower-priority QoL.

### G5 — Move `packages/docs` → `apps/docs`

Per AGENTS.md, docs sites belong under `apps/`. Cosmetic alignment;
blocked because the Vercel deployment's "Root Directory" is set to
`packages/docs/` via the project UI — moving from this side breaks
deploys until a UI change. Revisit on a release decision.

### F1 sui — `genesis` opt

Bind-mount a pre-baked genesis blob into the localnet container. The
upstream container generates genesis on `--force-regenesis` so this is
strictly an advanced case. Capture a concrete use case in
`friction.md` first before committing to an API shape.

### F2 walrus — `appendLog` supervisor-TUI plumbing, `nodeCount` opt, per-node `verify()` actions

- `appendLog`: walrus's build streams stderr. The missing piece is
  routing that stream through the supervisor's TUI panel via
  `ctx.appendLog`; bigger than just the walrus side.
- `nodeCount`: `NODE_COUNT = 4` is hardcoded across 8 sites (subnet IPs,
  port range, container names, config-gen). Refactor lift; defer until
  there's a concrete reason to need a different count.
- Per-node `verify()` actions: real new actions (one per node, probing
  REST API liveness). Worth its own focused PR.
