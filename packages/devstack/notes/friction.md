# Friction log — devstack

Per the repo `AGENTS.md`: capture friction here rather than papering over it. Anything that fights
you while writing Effect code in this package — confusing types, missing v4 docs, surprising
defaults, API drift from the writing-effect guide — goes here with a date and a one-line note. We
use this to decide whether the Effect spike is paying off.

## 2026-05-13 — phantom network types on interface tags

The type system doesn't track which network a package/registry was sourced from. A user writing
`provideDevstack([suiLocalnet(), deepbookKnownPackage({ network: 'testnet' })])` typechecks fine,
but `findPool` calls fail at runtime because the localnet RPC can't resolve testnet objects. A
future enhancement would add a phantom `<TNet>` type parameter to interface tags so
`deepbookKnownPackage({ network: 'testnet' }): Layer<DeepbookCore<'testnet'>>` and `findPool`
requires `Sui<'testnet'>`. Touches every interface tag (`Sui`, `WalrusNetwork`, `SealKeyServer`,
`DeepbookCore`, ...); deferred until the multi-impl matrix settles.

## 2026-05-13 — manifest SDK-ready `deepbook` block deferred

Aligning `DeepbookCoreShape.packageIds` (SCREAMING_SNAKE_CASE) + the new
`coins`/`pools`/`marginPools`/`pyth` maps on `knownDeployments.deepbook`,
we considered adding a dedicated `deepbook:` block to the manifest sidecar
so the frontend could `JSON.parse` the manifest and feed `packageIds` /
`pools` straight into `new DeepBookClient({...})`. Skipped this pass for
the same reason as walrus/seal (next entry): the manifest body sees only
the universal registries; threading `DeepbookCore` through would either
force consumers to compose `manifest` with deepbook-aware dependencies,
or duplicate the projection inside manifest. The `coins` block of the
manifest *is* aligned this pass (every coin entry now carries the SDK's
`{address, type, scalar}` projection via `sdkCoin`), so the most common
"feed coin metadata into a deepbook UI" path works without overrides.
Consumers that need the full `{packageIds, pools, marginPools, pyth}`
block today can opt-in via `manifest({ extras: Effect.gen(function* () {
const db = yield* DeepbookCore; return { deepbook: { packageIds:
db.packageIds, ... } }; }) })`. Revisit when a second consumer needs the
same projection.

## 2026-05-13 — manifest SDK-ready blocks for walrus/seal deferred

When aligning `WalrusNetworkShape.packageConfig` + `SealKeyServerShape.serverConfigs`
with the upstream `@mysten/walrus` / `@mysten/seal` constructors, we considered
adding dedicated `walrus` / `seal` blocks to the manifest sidecar (so the
frontend can `JSON.parse` the manifest and feed `packageConfig` / `serverConfigs`
directly into the SDK clients). Skipped this pass: the manifest body only sees
`PackageRegistry` / `EndpointRegistry` / `AccountRegistry` / `CoinRegistry` —
threading walrus/seal interface tags through via `Effect.serviceOption(...)` would
either force consumers to compose the manifest tag with walrus/seal-aware
dependencies (defeating the "manifest is universal" framing) or duplicate the
projection logic inside the manifest body. Consumers that need this today can
opt-in via `manifest({ extras: Effect.gen(function* () { const w = yield*
WalrusNetwork; return { walrus: { packageConfig: w.packageConfig } }; }) })` —
private-content does roughly this for seal already. Revisit when a second
consumer needs the same projection.

## 2026-05-13 — `seedMultipleAccounts` helper skipped

Phase 9 considered extracting a `seedMultipleAccounts(tx, accounts, distributions, buildCall)`
helper to sugar the `wallet/devstack.config.ts` faucet-distribution loop. Skipped: the actual
wallet pattern is `for spec in [usdc, weth]: for entry in distribution: t.moveCall(...)` where
each `entry` carries its own `{recipient, amount}` pair (i.e. amount varies per (spec, recipient),
not per spec). The proposed `accounts × distributions` cartesian-product shape — with one constant
amount per "distribution" — doesn't fit: it'd force callers to invert their data into a per-account
lookup before calling the helper, which is more code than the inline nested `for` it replaces.
A future helper that takes `ReadonlyArray<{target, args: (entry) => Argument[]}>` would generalise
better, but it'd be a wrapper around `t.moveCall` itself rather than an account-distribution
sugar. Revisit if a third example surfaces with the cartesian-product shape.

## 2026-05-13 — subpath `.d.mts` emitted by a separate `tsc` step (resolved)

The `./dapp-kit`, `./vitest`, and `./playwright` subpath exports used to point `types` at the
source files (`./src/<subpath>/index.ts`) because tsdown's bundler
(`rolldown-plugin-dts@0.23.2`) crashes while emitting their dts with
`Error: Failed to parse generated code for chunk node_modules/.../postcss/lib/postcss.d.mts —
SyntaxError: Export 'AcceptedPlugin' is not defined`. The bug is upstream in
`rolldown-plugin-dts`: postcss types reach the dts graph transitively via `@effect/vitest` and
`@mysten/dapp-kit-react`, and the plugin's `fake-js` parser mangles postcss's own d.mts during
chunk renaming. Consequence: every consuming example had `noUncheckedIndexedAccess: false` and
`types: [..., 'node']` overrides so TypeScript could chase the subpath types into the package's
`src/` (which references internal modules that need those settings).

**Resolution (Phase 10):** added a `build:dts-subpaths` step that runs
`tsc -p tsconfig.subpaths.json` (declarations only, no bundling) into `dist/.dts-subpaths-tmp`,
then `scripts/finalize-subpath-dts.ts` copies just the three subpath dirs into
`dist/<subpath>/*.d.mts`, rewriting relative `.js` import specifiers to `.mjs` so the artefacts
align with tsdown's `.mjs` output. The main tsdown build still owns dts for `./` and
`./plugin-author`; the fixtures config keeps `dts: false`. `package.json` `exports[*].types`
for the three subpaths now point at `./dist/<subpath>/index.d.mts`, and every example +
`packages/create-devstack-app/template` dropped the `noUncheckedIndexedAccess: false` /
`types: [..., 'node']` overrides.

**Remaining limitation:** the dts pass duplicates work — tsc visits the whole `src/` tree even
though only three barrel files matter to consumers. Build is still <2s end-to-end, so it
hasn't bitten yet, but a watch-mode user would notice the extra latency.

**Re-investigate when:** `rolldown-plugin-dts` ships a fix for the postcss parse crash (track
<https://github.com/sxzz/rolldown-plugin-dts/issues>). Once a tsdown release rolls the fix
forward, flip `dts: false` → `true` on the `fixtures` config in `tsdown.config.ts`, delete
`tsconfig.subpaths.json` + `scripts/finalize-subpath-dts.ts`, and collapse the build script
back to `tsdown`. The `pnpm -r --filter "./examples/*" typecheck` check should still pass.

### accounts production loading (resolved 2026-05-13)

`accounts({alice: {}})` today supports four sources via the `from:` discriminator:
- `from: 'ephemeral-funded'` (the default for bare `{}`) — localnet only; derives a fresh Ed25519 keypair, persists to `.devstack/stacks/<stack>/.keys/<name>.key`, requests faucet funding. Requires `sui.faucetUrl` to be set (i.e. `suiLocalnet` or `suiTestnet`).
- `from: 'keystore'` — read from `~/.sui/sui_config/sui.keystore` by alias.
- `from: 'env', key: 'X'` — read from `process.env[key]`.
- `from: 'inline', privateKey: '...'` — literal `suiprivkey1...` in the config (tests/demos only).

This unblocks `provideDevstack` for production Effect apps. See `src/primitives/accounts.ts` for the source.

## 2026-05-13 — CLI `--help` surface verified

Production-readiness flag: confirm every CLI verb is reachable from `devstack --help`. Verified
against `dist/cli/main.mjs --help` after `pnpm build`. Top-level verbs covered:

- `up`, `apply`, `status`, `snapshot`, `wipe`, `stack`, `doctor`, `manifest`, `version`

Nested groups walked:
- `snapshot`: `save`, `restore`, `list`, `delete`
- `stack`: `list`, `new`, `use`, `down`, `drop`

Each verb renders a description and a usage line. No commands are missing from `--help` and no
expected verb is absent from the tree — locked into a smoke test at `src/cli/main.test.ts` that
walks `rootCommand.subcommands` against a hardcoded expectation, so a future refactor that drops
a `withSubcommands` entry fails in CI rather than silently shipping a CLI missing a verb.

Minor nits observed (not blocking):

- `apply` and `status` print `--json` with no description column in `--help`. `effect/unstable/cli`
  renders the flag name + type but the description slot is empty because the `Flag.boolean('json')`
  call doesn't chain `Flag.withDescription`. Worth tightening before 1.0; one-line change per call
  site in `commands/apply.ts` + `commands/status.ts`.
- `manifest` is documented as a stub (`Print the current .devstack/manifest.json (stub)`). That's
  correct today — the real implementation lands once the manifest primitive does — but the help
  text could call out which command writes the manifest (`apply`) so a user who hits the stub
  doesn't have to dig through source to learn where `.devstack/manifest.json` comes from.
- No `accounts list` / `accounts show` / equivalent verb. Doesn't matter today (every example
  derives its accounts at config time), but once teams ship `provideDevstack`-backed services to
  production, a "what's persisted in `.devstack/.keys/`" introspection command would save them
  poking at the filesystem. Defer until a concrete user asks for it.

## 2026-05-13 — TUI `r` retries the whole stack (resolved 2026-05-13)

Resolved: `r` now retries ONLY the failed primitives via per-primitive child scopes; `R`
(Shift+R) keeps the full-stack restart contract. The landing required:

- per-primitive supervisor fibers in `forkPrimitive` (`src/define-devstack.ts`): each owns a
  chain of child scopes forked off the supervisor scope, so a failure only tears down THAT
  primitive's resources;
- per-tag retry Deferreds on the engine (`retryFailed`, `awaitRetry`, `signalRetry` in
  `src/internal/engine.ts`);
- a `sharedCtxRef` accumulator at the supervisor level so dependent primitives (e.g.
  `accountAlice` yielding `Sui`) can find provider services on retry.

Cascading-retry is automatic: when any primitive's retry succeeds, every currently-failed
sibling is signalled to re-attempt — Sui retrying clean wakes `accountAlice` and it finds the
new service on its next try. Test coverage:
`forkPrimitive — per-primitive scope isolation` group in `src/define-devstack.test.ts`.

Out of scope (not addressed by this pass): primitives that succeed at acquire-time but fail
later at runtime (e.g. a sui-localnet container OOMing after 5 minutes). Once a primitive
has acquired, its runtime health is its own concern — supervision-by-retry only applies to
acquire-time failures.
