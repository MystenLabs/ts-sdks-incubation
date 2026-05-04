# Round 3 — what's left after the project review + AB-funding work

Synthesis of remaining items across `notes/project-review.md`,
`notes/friction-cleanup-plan.md`, `notes/friction.md`, and
`notes/architecture-review-followups.md`. Round 1+2 (PRs 19-35)
closed every P0, every P1 from the review, the Round 2 walrus
subnet + double-reconcile + mUSDC flake, and the user-asked address-
balance migration. Stack health: 7/7 wallet e2e cold + warm; 335/335
devstack tests; zero open friction blockers.

## What this plan covers

12 items grouped by tractability. Each has a concrete fix shape +
file paths so a contributor can pick one without re-deriving the
context. Sequenced as 3 phases: ready-to-ship (4 PRs), substantial
but specced (4 PRs), bundled polish (1 sweep). The architecture-
review-followups backlog (`globalThis.__devstackDAppKit__` removal,
NFT example, scaffolder, etc.) stays deferred at the bottom — those
need a real consumer push, not anticipatory shipping.

| Phase | PRs | Lines (est) | Theme |
| ----- | --- | ----------- | ----- |
| A — ready-to-ship | 36-39 | ~600 | DX + docs gaps the review surfaced |
| B — substantial | 40-43 | ~1500 | Examples consolidation + scaffolder seed |
| C — polish | 44 | ~150 | One sweep of P3 cleanups |

Plus one explicit "do not do" section so future contributors don't
re-attempt items that were considered and rejected.

---

## Phase A — ready-to-ship

### PR 36 — CLI `--json` output mode (~200 lines)

**Friction**: CI consumers (`apply`, `deploy`, `snapshot save`,
`snapshot hash`) regex-parse the human-formatted summary table.
Project review:
> No JSON output mode anywhere. CI consumers regex-parse human strings.

**Mechanism**: each verb's CLI handler accepts `--json`. When set:
- Suppress the human summary block.
- After the cycle, `process.stdout.write(JSON.stringify(result) +
  '\n')` with a stable schema.
- One-line-per-event progress format (newline-delimited JSON) when
  `--json --verbose`, similar to `gh run watch --json`.

**Schema** (proposed): `{ kind: 'summary' | 'progress' | 'failure',
  ... }`. Per-action: `{ name, type, status, durationMs, detail?,
  error? }`. Snapshot: include the resolved id + alias + image tags.

**Files**:
- `packages/devstack/src/cli/apply.ts:55-66` — branch on `flags.json`.
- `packages/devstack/src/cli/deploy.ts` — same.
- `packages/devstack/src/cli/snapshot.ts:107-145` — emit the
  capture/restore manifest.
- `packages/devstack/src/cli/args.ts` — `parseJsonFlag`.
- `packages/devstack/src/runtime/status-renderer.ts` — new `JsonRenderer`
  that consumes the same `progress` callback and emits NDJSON to stderr.

**Verify**: `pnpm devstack apply --json | jq '.summary.failures'`
returns 0 on success. CI workflow consumers can drop their regex.

### PR 37 — Walrus 1.48.0 TLS panic (~50 lines)

**Friction**: `notes/friction.md` — walrus storage nodes start, open
RocksDB, bind REST API on `10.<octet>.0.10:9185`, then panic in
`axum-server-0.8.0/src/tls_rustls/mod.rs:204`. Blocks
`private-content` end-to-end blob upload (Seal works without walrus
storage but the upload path doesn't).

**Mechanism**: bump `WALRUS_REV` in `plugins/walrus/build.ts:32`
past the axum-server 0.8.0 dependency. Recent walrus-node releases
on `MystenLabs/walrus@main` have moved off 0.8.0; pick the most
recent stable rev that builds cleanly against the bundled sui
binary at `/root/sui_bin/sui`. Bump `WRAPPER_REV` r3 → r4 so the
local image cache invalidates.

**Verify**: `private-content` cold apply leaves all 4
`walrus.node-N` containers healthy; `walrus.register` registers
the 4 nodes; `seal-flow.spec.ts` blob upload succeeds.

**Fallback**: if no recent walrus rev fixes the issue, capture as a
deeper friction (the upstream walrus team owns the axum upgrade).

### PR 38 — `troubleshooting.mdx` doc page (~120 lines)

**Gap**: `notes/architecture-review-followups.md:122-124`. No single
"my localnet won't come up" page; users grep `notes/friction.md`.

**Content** (one mdx page, ~5 sections):
- **Docker not running / not reachable** — symptom: `cannot
  connect to the Docker daemon`. Fix: `colima start` /
  `Docker Desktop launch`. How to verify: `docker info`.
- **Port collision** — symptom: `Bind for 0.0.0.0:<port> failed: port
  is already allocated`. Fix shape: another stack of the same app
  (drop it), another app on the host (per-stack allocator handles
  this; rerun), or a non-devstack process (`lsof -i :<port>`).
- **Faucet 500 on cold first run** — symptom in
  `notes/friction.md:110`. Fixed by `keys.ts:64` retry-with-backoff;
  if still seen, surface as a transient with `pnpm devstack apply`
  re-run.
- **`mysten-dapp-kit-connect-button` never appears in e2e** —
  symptom from PR 22's regression. Causes: dev-wallet adapter
  initialization failure (browser console), bundle import error.
  Fix: rebuild devstack, check browser dev-tools console.
- **Walrus nodes don't become healthy** — currently the open
  friction (PR 37 fix it pending). Workaround: use a non-walrus
  app for now.
- **Snapshot restore mismatch** — when `<sha-id>` doesn't exist or
  arch mismatches, what to do (`devstack stack snapshot list`,
  drop + re-up).

**Files**:
- NEW `packages/docs/content/devstack/troubleshooting.mdx`.
- MODIFY `packages/docs/content/devstack/meta.json` — add to nav
  under Reference.

**Verify**: `pnpm validate-docs` clean.

### PR 39 — `plugin-authoring.mdx` recipe (~180 lines)

**Gap**: `architecture-review-followups.md:122-124`.
`authoring/define-plugin.mdx` is reference. Users want a worked
walkthrough of "I'm authoring my first plugin from scratch."

**Content**: complete walkthrough of building a plugin like the
deepbook one — from "I have a Move package and want a typed
declarative surface" to a working `myPlugin()` plus an example
app importing it. Covers:
- Picking the right action types (Build vs Service vs Publish vs
  Seed vs HostProcess).
- `getStatus` content-not-metadata principle.
- `provides:` capabilities for cross-plugin ordering.
- `runsAs:` for same-signer serialization.
- Registry namespace via `ctx.registry.ns<MyNs>('myplugin')`.
- Snapshot meta on container services.
- Surfacing helper functions (e.g., `buildSwapTx` style) from the
  plugin's barrel.

Reference example throughout: a hypothetical `walrus-bridge()`
plugin (one Service + one Register + one Seed). Concrete code,
not abstract API descriptions.

**Files**:
- NEW `packages/docs/content/devstack/authoring/plugin-authoring.mdx`.
- MODIFY `packages/docs/content/devstack/meta.json`.

**Verify**: `pnpm validate-docs` clean. Cross-link from
`define-plugin.mdx` (top of page: "for a from-scratch walkthrough
see plugin-authoring").

---

## Phase B — substantial

### PR 40 — Extract `Card.tsx` + form `Field` to a shared `react/ui` (~200 lines) — **DONE**

**Friction**: `notes/project-review.md` — `Card.tsx` is byte-
identical (modulo FRICTION-tagged comments) across all 4 example
apps. The `Field` form-row primitive is duplicated in `SendForm`,
`SwapForm`, `TransferForm`, etc.

**Mechanism**: New `packages/devstack/src/react/ui/` directory with
`<Card>`, `<Field>` exported from
`@mysten-incubation/devstack/react/ui`. The 4 example apps replace
their local copies with pass-throughs (or direct imports).

**Why a separate sub-export**: `react/ui` adds opinionated styling
(Tailwind classes inlined). Apps that don't use the design system
shouldn't pay for the import. Sub-export keeps it opt-in.

**Files**:
- NEW `packages/devstack/src/react/ui/Card.tsx`.
- NEW `packages/devstack/src/react/ui/Field.tsx`.
- NEW `packages/devstack/src/react/ui/index.ts`.
- MODIFY `package.json` `exports` — add `./react/ui`.
- DELETE `examples/*/src/components/Card.tsx` (4 files).
- MODIFY `examples/*/src/components/SendForm.tsx` etc. — import
  from `@mysten-incubation/devstack/react/ui`.

**Verify**: 4 example apps still typecheck + visual rendering
unchanged + e2e green.

### PR 41 — Extract `dapp-kit.ts` to `packages/devstack-app-setup/` (~250 lines) — **DONE**

**Friction**: `dapp-kit.ts` is 37 lines × 4 apps, byte-identical.
Already flagged in `architecture-review-followups.md:42-50`.

**Mechanism**: New `packages/devstack-app-setup/` package
(workspace-internal) that exports `createWalletApp({ manifest })`
returning `{ dAppKit }`. Encapsulates:
- `configureDevstackPanels(manifest)`
- `createDevstackAdapterFromManifest(manifest)`
- `createDAppKit({ ...localnetDappKitConfig(manifest), walletInitializers: [devWalletInitializer({...})] })`
- The `globalThis.__devstackDAppKit__` test-only assignment

Apps shrink to:
```ts
import { manifest } from 'virtual:devstack-manifest';
import { createWalletApp } from '@mysten-incubation/devstack-app-setup';

export const { dAppKit } = createWalletApp({ manifest });
```

**Why a separate package**: the helper depends on `dev-wallet` +
`devstack-wallet-panels` which not all apps need. Putting it in
`@mysten-incubation/devstack/react` would force every app to pull
those even if they're not using the dev-wallet pattern.

**Files**:
- NEW `packages/devstack-app-setup/{package.json,src/index.ts,...}`.
- MODIFY each `examples/*/src/dapp-kit.ts` — single-line
  delegation.
- MODIFY `examples/README.md:47` — update the directory tree
  comment.

**Verify**: 4 example apps still typecheck + e2e green.

### PR 42 — `examples/_template/` + scaffolder seed (~400 lines) — **DONE**

**Friction**: `architecture-review-followups.md:56-67`. The template
+ `pnpm create devstack-app` scaffolder from Round-1 don't exist.
`examples/README.md:28-48` references `examples/_template/` but the
dir is missing.

**Mechanism**: scope this PR to JUST the `_template/` directory
(not the scaffolder package — that's PR 43). The template is the
canonical "minimal but real" devstack app:

- One Move package (`move/hello/`) with a single `mint` entry.
- `devstack.config.ts` with `sui()` + `codegen()` + `walletServer()`
  + `frontend()` + a `setup:` block doing one publish + one
  `runTransaction`.
- `src/dapp-kit.ts` (using PR 41's `createWalletApp`).
- `src/App.tsx` with a Card showing the published package id and a
  button to mint.
- `e2e/mint.spec.ts` exercising the connect-and-mint flow.
- `playwright.config.ts` (using `await defineDevstackPlaywrightConfig`).

Naming: `_template` (underscore-prefixed) so it doesn't show up in
`pnpm -r` workspace iteration as a real example. Already in
`pnpm-workspace.yaml`'s implicit-include path.

**Files**:
- NEW `examples/_template/` — entire directory tree.
- MODIFY `examples/README.md` — point at it as the starting place,
  remove the "doesn't exist yet" friction.

**Verify**: from a fresh checkout, `cp -r examples/_template
examples/myapp && cd examples/myapp && pnpm install && pnpm dev`
brings up a working stack.

### PR 43 — `pnpm create @mysten-incubation/devstack-app <name>` (~600 lines) — **DONE**

**Friction**: `architecture-review-followups.md:56-67`. Apps need a
quick scaffold path that bumps the example count without
hand-pasting boilerplate.

**Mechanism**: New `packages/create-devstack-app/` (the
`pnpm create` convention). The `bin` entry generates a fresh
`examples/<name>/` (or sibling at the user's CWD) by:
1. Cloning `examples/_template/` (PR 42).
2. Templating substitutions: app name, package name, port-base,
   account list.
3. Running `pnpm install` in the new dir.
4. Running `git init` + initial commit (skippable with `--no-git`).

Port allocation: `hashString(appName)` derives a deterministic
preferred port-base — collisions are rare and the per-stack port
allocator handles them at runtime anyway.

**Files**:
- NEW `packages/create-devstack-app/{package.json,src/index.ts,
  bin.ts}`.
- NEW `packages/create-devstack-app/README.md`.
- MODIFY `pnpm-workspace.yaml` — include the new package.

**Verify**:
- `pnpm create @mysten-incubation/devstack-app my-test-app` from a
  fresh dir produces a working app.
- Output app passes `pnpm typecheck` + `pnpm test:e2e` immediately.

---

## Phase C — bundled polish (PR 44, ~150 lines, single sweep) — **DONE**

P3 items grouped into one sweep so the diff stays reviewable. From
`notes/project-review.md` and the post-review project-review:

- **Dead exports**: `runtime/snapshot.ts:550` `snapshotDirFor`,
  `cli/snapshot.ts:175` `suiContainerName`, `helpers.ts:35`
  `keyFilePath`/`keysDir`/`loadOrGenerateKeypair`. Either delete or
  document why they're public.
- **`port as number` casts (6 sites)**: `port-allocator.allocate`
  returns `number[]` already. Either `noUncheckedIndexedAccess`
  defaults are fine (drop casts), or destructure with explicit
  fallback if the indexed access is genuinely unguarded.
- **Banner-style file headers**: `plugins/sui/index.ts:1-43`,
  `plugins/walrus/index.ts:1-45`, `runtime/supervisor.ts:1-18`,
  `cli/filters.ts:1-28`, `actions/transaction.ts:1-34`. CLAUDE.md
  says no narration; trim each to a single short paragraph.
- **Design-doc references that will rot**: comments referencing
  `§9.4`, `Q5`, `Q11`, `Discovery 2026-04-29`. Replace with the
  rationale itself (1-2 sentences) or drop the reference.
- **Move `edition` mixed**: `wallet/move/mock_usdc/Move.toml:3` uses
  `2024.beta`; `arena/move/connect_four/Move.toml:3` uses `2024`.
  Pick one (recommend `2024`) across all examples.
- **Missing test-id**:
  `token-studio/src/components/Balances.tsx:62` lacks
  `data-testid="balance-{name}-{symbol}"` that wallet's e2e pattern
  expects. Add it for cross-example consistency.
- **Stale build artifacts**: re-confirm
  `examples/arena/*.{config.js,d.ts}` and
  `examples/private-content/*.{config.js,d.ts}` are gitignored
  cleanly; add `.gitignore` entries if any sneak through.

Single commit, single PR, ~150 lines net. Verify: typecheck +
tests green; no behavior change.

---

## Out of scope (rationale)

These stay deferred until a specific consumer pushes on them.
CLAUDE.md's "extract from evidence, not anticipation" applies — we
don't ship without a real customer.

| Item | Why deferred |
| ---- | ------------ |
| `globalThis.__devstackDAppKit__` removal | Major-bump churn; no consumer asking for it. The slot only matters for the Playwright `connectAs` helper, and that's the use case. |
| Codegen MVR-pattern validation upstream in `@mysten/codegen` | Cross-repo; tracked separately. |
| Container-name format / `'sui-rpc'` slot name as constants | Would touch 9-12 plugins; the strings are already namespaced. Not blocking anything. |
| New `Restore` action type | The CLI surface + getStatus skip-predicates do the same job. Adding an action type is speculative complexity. |
| `upgrade()` action factory | Capture records UpgradeCap object IDs; user code can build the upgrade tx. Promote when an example needs it. |
| `imports` plugin patch/transform hook | Hook fires before publish; lets specs rewrite Move.toml/sources. Add when a real upstream package needs it. |
| `seedSharedObjects` plural helper | Singular `seedSharedObject` covers the case. Promote when 3+ apps want the array form. |
| Async-factory account materialization | KMS / Ledger / passkey signers that need network-side init. Add when a real-world signer needs it. |
| Vitest testcontainers-per-file integration | The M9-era promise. Heavier than it sounds. Defer until a real test suite needs per-file isolation. |
| JSON status-renderer skip-reason classification | The `--json` output (PR 36) covers status-only. Skip-reason classification is a refinement. |
| NFT/Kiosk example app | Substantial work — a real Move package, UI flows, e2e tests. Land after Phase B (template + scaffolder) so the new example uses the consolidated wiring. |

These collectively are real work but represent ~3-6x the lift of
Phases A-C combined. Re-evaluate after Phase C lands.

---

## Verification

After each PR:
- `pnpm typecheck` (devstack + every example)
- `pnpm test --run` (devstack)
- `pnpm test:e2e` against `wallet` (the most-exercised example)
- `pnpm validate-docs` for any docs touch

After the whole sequence:
- Cold + warm e2e on wallet + arena + token-studio (private-content
  blocked on PR 37's walrus rev bump)
- A snapshot save/restore roundtrip
- Run the scaffolder against a fresh dir and run the resulting
  app's e2e

---

## Architectural notes for future plans

- **Two consolidations make the example matrix sustainable.** PR 41
  (`devstack-app-setup`) collapses `dapp-kit.ts`. PR 40
  (`react/ui`) collapses the form primitives. Together they cut
  per-app boilerplate by ~70 lines, making "add a new example app"
  cheap enough that a scaffolder is worth shipping (PR 43).
- **`troubleshooting.mdx` is the seam where every "this hurt"
  surface needs to land.** Closed friction-journal entries should
  also surface there (with the closure noted) so users hitting the
  same shape see "this is a known thing, here's how to verify".
- **`--json` is the gate for CI integration.** Once apply / deploy
  / snapshot all support it, the GHA-cache workflow shape from
  `notes/state-and-snapshots-plan.md:PR 7` becomes trivial to
  ship — no regex parsing.
- **Out-of-scope items aren't "won't do" — they're "not yet".** The
  rationale column is the customer signal we'd need to flip them.
  Every entry has a "promote when" condition.
