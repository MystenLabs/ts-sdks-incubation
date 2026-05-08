# CLAUDE.md

Conventions for AI assistants working in this repo. Apply alongside any IDE-specific configs in
`.cursor/`, `.claude/`, `.opencode/`.

## What this repo is

A monorepo of high-quality Sui example apps + a devstack for fully-seeded local development. The bar
is "scaffold-eth-2 for Sui." Build quality matters; cute matters.

Devstack is at 0.1.0 — initial public release. Treat the public API as semver-bound; breaking
changes land at minor-version bumps in the 0.x series.

## Code conventions

- **TypeScript strict everywhere.** `noUncheckedIndexedAccess`, `noUnusedLocals`, no `any` without
  comment justifying it.
- **Tabs for indentation** (Biome enforces). Single quotes, semicolons, trailing commas.
- **Imports**: `import type` for type-only imports (Biome enforces). Use `node:` protocol for
  built-ins.
- **No comments** unless they explain a non-obvious _why_. Don't narrate code.

## File / package conventions

- Examples live in `examples/<name>/`. Each app self-contained: own Vite config, own Move package(s)
  under `move/`, own runtime state under `.devstack/`, own e2e under `e2e/`.
- Shared code in `packages/<name>/`. Use `workspace:*` for in-monorepo deps. Use `catalog:` for
  `@mysten/*`, React, build tools so versions stay aligned across apps.
- Move package layout: `examples/<app>/move/<package_name>/{Move.toml,sources/}`. Use snake_case for
  package and module names (Move convention). Always use `--json` when invoking `sui client publish`
  from scripts.

## Testing

- **Unit/integration**: Vitest, in `src/**/*.test.ts(x)` or sibling `__tests__/` folders.
- **E2E**: Playwright, in each app's `e2e/` folder. Real localnet, real wallet adapter — not mocks.
  Mocks for unit tests only.
- **Fresh localnet per test file** via the e2e harness's `manageStack: true` flag (Playwright
  globalSetup brings up a hermetic stack before tests; globalTeardown disposes per the configured
  `teardown:` mode). Pre-fund accounts in `globalSetup`, claim from a pool — never faucet-per-test.

## Anti-patterns we will not repeat

From `MystenLabs/deepbook-sandbox`:

- Hardcoded ports anywhere outside the port allocator
- Long-running processes that `process.exit(1)` on transient errors with no restart
- `git checkout` to restore mutated config files (generate, don't mutate)
- Always-on services that can't be opted out per-app

From `MystenLabs/ts-sdks` (specialized, not bad — but don't copy wholesale):

- Copy-pasted `globalSetup.ts` across multiple packages
- Faucet-per-test in the hot path (5–10s per call)
- Mock-only tests for hooks that need a real chain to verify

## Setup design — the action graph IS the lifecycle

App-level setup actions appear inline in `DevstackConfig.use: [...]`
alongside plugins. Bare actions in `use:` are folded into a synthetic
`<app>-setup` plugin at config-load time, so cross-action `needs:`
references resolve consistently. We deliberately do not expose parallel
lifecycle-hook APIs (`afterStackUp`, `afterPublish`, etc.) because the
action graph already covers the use cases:

- **Ordering** — express via `needs:` (`needs: ['sui.accounts']`,
  `needs: ['my-package']`).
- **Idempotence** — express via `getStatus`. The reconciler also folds
  every action's input hash into persisted state in the manifest at
  `<appDir>/.devstack/stacks/<stack>/manifest.json` (under
  `actionStates['<plugin>.<action>'].lastInputHash`); a stale hash
  forces a re-run on the next cycle. Editing a `runTransaction`
  build callback flips the hash and re-fires.
- **Snapshot composition** — `actionStates` are part of the manifest, so
  `snapshot save` captures them; restore brings them back; setup skips.
- **Same-signer serialization** — `runsAs:` (defaulted by
  `publishMove`/`runTransaction` from `publisher`/`signer`; passed
  explicitly on raw `seed()` whose body signs through
  `ctx.accounts.get(...)`). The reconciler runs at most one inflight
  action per distinct `runsAs` value so two same-account actions don't
  equivocate on the gas object — apps don't need to thread synthetic
  `needs:` edges between them. **`runsAs:` provides exclusivity, not
  ordering.** Two ready-to-run actions with the same `runsAs` value
  fire one-at-a-time, but the order between them is scheduler-arbitrary
  across cycles. Apps that need a specific order (e.g. action B must
  observe action A's on-chain effect) should still thread the edge
  explicitly via `needs:`.

A separate hook system would either duplicate this or coordinate
poorly with snapshots (re-running on every restore wastes work; not
re-running collapses into the same action-graph idempotence). Setup
actions ARE the lifecycle.

## Helpers vs raw factories

`publishMove()` and `runTransaction()` are sugar over the raw
`publish` / `seed` factories from
`@mysten-incubation/devstack/authoring`. They cover the 90% case;
they will not grow into a catalog. Anything outside drops into the
raw factories directly inside `use: [...]` — both forms are
first-class. App authors should reach for the helpers; the
`/authoring` subpath is for third parties writing custom plugins.

The main barrel re-exports `register`, `emit`, `verify`, `seed`, and
`registerCoin` directly, so app code doesn't need to reach into
`/authoring` for those — only `definePlugin`, `buildImage`, `service`,
`containerService`, `hostProcess`, and `publish` (the lower-level
factories that have ergonomic wrappers in the main barrel) require
the `/authoring` subpath.

### `Plugin<TProvides>` + runtime `provides`

The `Plugin<'foo.x' | 'foo.y'>` annotation flows into
`defineDevstackConfig`'s typed-needs validator (catches typos in
`needs:` references). It's purely type-level.

Plugins MAY also set runtime `provides: ['foo.x', 'foo.y']` array
which mirrors the type union. When set, `expandPluginActions`
cross-validates: every action returned must appear in `provides`,
and vice versa. Catches drift between the type annotation and the
actual `actions:` body at runtime.

Skip `provides:` when action names are dynamic (template-literal
types like `walrus.node-${number}`) — the runtime check can't
enumerate them. Built-ins `walrus`, `deepbook`, `imports` skip;
static plugins (`sui`, `seal`, `accounts`, `codegen`, `frontend`,
`wallet-app`) opt in.

## When invoking the Sui CLI from scripts

Always:

- `--json` flag, parse with proper TypeScript types (no `any`).
- Pre-set `~/.sui/sui_config/client.yaml` so no interactive prompts.
- Wrap in retries with exponential backoff + jitter; don't use flat polling.
- Fail loudly with an actionable message if Docker / RPC / faucet aren't ready.
