# Architecture-review follow-ups — closeout from 2026-05-19 review

## Status (2026-05-19)

Waves 1 + 8 substantially shipped (one-line surface fixes + maintainer decisions). DeepBook + Postgres
single-source-of-truth refactor (Wave 2), override-field hygiene (Wave 3), documentation rollout (Wave
4), typed-error consolidation (Wave 5), and the synthesis/05 deletion sweep (Wave 6) are still in
flight or partially landed. The 8 open structural decisions in §10 gate Waves 2/3/5/6. Note: this
plan references several files deleted in the synthesis/05 sweep (`engine/host-gateway.ts`,
`engine/cache.ts` (the original ~28-LoC stub — recreated since for `withCache`),
`runtime/endpoint-names.ts::dev_server_fallback`) — those references are historical and the deletion
checkbox is `[x]` against them.

**Status:** Plan ready for kickoff (2026-05-19). Synthesis of every finding from the multi-agent
architectural review at `.review-findings/` (REVIEW.md + 6 syntheses + 31 underlying reports).

This plan folds in **all** findings — Tier A, B, C from REVIEW.md, the removal candidates from
`synthesis/05-overbuild-and-dead-code.md`, the open structural questions in REVIEW.md Part 5, and
the writeup-friction items in `synthesis/00-architecture.md`. Nothing flagged should be missing.

Prior plans (still extant, post-2026-05-19 trims):

- `api-simplification.md` — historical ledger
- `post-launch-sweep.md` — Waves 1–4 (W12 / O22 / Signer adoption / Snapshot JSDoc); some items in
  this plan overlap and are flagged inline (e.g. Wave 4.1.4 here = same as post-launch-sweep §3.1 if
  not yet shipped)
- `deepbook-plugin-expansion.md` — trimmed; this plan absorbs the URL-ownership work (Wave 2)
- `sui-fork-integration.md` / `sui-fork-phase-5.md` — separate scope; not touched here

**§10 decisions settled before kickoff:** none. **8 decisions are open** and listed in §10 — they
gate Waves 2 and 6.

---

## §1 Goals

- Resolve the only HIGH × HIGH finding: DeepBook + Postgres single-source-of-truth violations (Wave
  2).
- Wire the load-bearing observability helper (`annotateDevstackContext`) that AGENTS.md mandates but
  the code never calls (Wave 1).
- Close the doc-vs-code mismatches on the `/advanced` barrel (`CodegenError`,
  `DeepbookConfigEmitter`, `FaucetRequestError` claimed in docstring but not exported) (Wave 1).
- Land the `Snapshot participation:` docstring discipline AGENTS.md prescribed but the code never
  adopted (Wave 4).
- Sweep the deletion list from `synthesis/05` (host-gateway, cache.ts, dead `withDevstack` /
  `setupDevstack`, etc.) (Waves 1 + 6).
- Settle the 8 open structural decisions (§10) before the dependent waves kick off.

Non-goals:

- Touching the grandfathered monolithic services (`services/sui.ts`, `services/account.ts`,
  `services/seal/internal.ts`, `services/walrus/internal.ts`) — AGENTS.md explicitly grandfathers
  them.
- Branded-types sweep for endpoint name strings / state-store keys / span names (§11 deferral).
- New example apps (beginner-deepbook, custom-Codegen-emitter, custom-Faucet-strategy) — separate
  plan (§11 deferral).
- Re-litigating any of the "what's clean" items in REVIEW.md Part 3a — they're working as intended.

---

## §2 Wave structure & parallel execution recipe

Eight waves, sized by maximum useful parallelism. Items inside a wave are file-disjoint (or further
partitioned) so a single `Agent` fan-out can ship the wave.

| Wave | Theme                                                         | Fan-out shape                                           | Gate to next                              |
| ---- | ------------------------------------------------------------- | ------------------------------------------------------- | ----------------------------------------- |
| 1    | One-line surface fixes (Tier A.2 + A.3 + small deletes)       | N parallel subagents (one per item — all file-disjoint) | None — independent items, merge any order |
| 2    | DeepBook + Postgres single-source-of-truth (Tier A.1)         | 2 parallel subagents (deepbook + postgres)              | Decisions §10.1, §10.2 settled            |
| 3    | Override-field fate + discriminator hygiene (Tier A.4)        | 4 parallel subagents (deepbook, seal, walrus, pyth)     | Decisions §10.3, §10.5 settled            |
| 4    | Documentation rollout (Tier B.1 + B.4 + AGENTS.md cross-refs) | 5-way fan-out for docstrings + 1 sweep for spans        | None — independent                        |
| 5    | Typed errors + known-package consolidation (Tier B.2, B.6)    | 2 streams (error classes + known-package files)         | Decision §10.6 settled before stream 2    |
| 6    | Removal sweep — full `synthesis/05` list (Tier A.5 + extras)  | Multi-stream parallel (each item file-disjoint)         | Decisions §10.4, §10.7, §10.8 settled     |
| 7    | Housekeeping (Tier C, lazy-during-touch)                      | Loose parallel; opt-in                                  | None — opt-in                             |
| 8    | Maintainer decision pack (§10)                                | n/a — maintainer review                                 | Gates Waves 2, 3, 5, 6                    |

Per-wave parallel recipes are at the head of each § below.

---

## §3 Wave 1 — One-line surface fixes (fully parallel)

**Recipe:** Single `Agent` message with one subagent per item below. Each is file-disjoint from the
others. Total wall-clock ≈ time of the slowest item (~10 min).

### 3.1 — [x] Wire `annotateDevstackContext()` into `withEngineLifecycle` (Tier A.2) — XS

> Done 2026-05-19: wired `annotateDevstackContext(plugin ?? key)` into `withEngineLifecycle` in
> `advanced/tag.ts`, gated on Identity-service availability so standalone tests stay a noop; added
> `plugin?:` to the classification record so the plugin attribution flows through.

**File:** `packages/devstack/src/advanced/tag.ts` (the central wrap that every primitive's build
runs through; per `round1/04-tag-substrate.md` § 2 and `round1/01-engine-core.md` § 2.1).
**Action:** Inside `withEngineLifecycle(key, build)`, before invoking `build`, add a
`yield* annotateDevstackContext(service)` so every primitive's span carries the three universal keys
(`service.name`, `devstack.stack`, `devstack.app`) per AGENTS.md § "Observability".

**Evidence of need:** `round3/04-observability.md` § 2 — grep across the repo finds **zero callers**
of `annotateDevstackContext` outside the declaration site. 96 spans are stamped without the three
universal keys.

**Risk:** the helper currently takes `service: string`; `withEngineLifecycle` knows the tag key but
not necessarily a "service name". May need to derive from `__pluginName` field on the LayeredTag.
Validate before edit.

**LoC:** +1 to +5. **Parallel:** ✅ standalone.

### 3.2 — [x] Add missing `/advanced` exports (Tier A.3) — XS

> Done 2026-05-19: added `DeepbookConfigEmitter`, `CodegenError`, and `FaucetRequestError` exports
> to `advanced/index.ts`, aligning with the barrel docstring's existing claims.

**File:** `packages/devstack/src/advanced/index.ts` (3 lines added). **Action:** Add:

```ts
export { DeepbookConfigEmitter } from '../codegen/emitters/deepbook-config.js';
export { CodegenError } from '../codegen/errors.js';
export { FaucetRequestError } from '../services/faucet/index.js';
```

The barrel's header docstring (lines 18-22) already claims `CodegenError` and
`DeepbookConfigEmitter` are part of the "Codegen plugin-author surface"; this aligns code with doc.

**Evidence of need:** `round1/16-codegen-subsystem.md` § "Public exports from /advanced",
`round2/07-error-model.md` § 4.

**LoC:** +3. **Parallel:** ✅ standalone.

### 3.3 — [x] Delete `engine/host-gateway.ts` — XS

> Done 2026-05-19: removed unused `engine/host-gateway.ts`; whole-package grep confirms zero
> importers (the `host.docker.internal` literal is inlined at its few callsites).

**File:** `packages/devstack/src/engine/host-gateway.ts` (delete entirely; ~20 LoC). **Action:**
Whole-repo grep for `rewriteToHostGateway`, `hostGateway`, `host-gateway` confirms zero non-self
importers. The string literal `host.docker.internal` is used directly elsewhere (8+ callsites across
docker/, services/). Delete the file.

**Evidence of need:** `synthesis/05-overbuild-and-dead-code.md` § 1, `round1/01-engine-core.md` §
4.1 Finding 3.

**Verify:** re-grep `host-gateway` after delete; nothing should hit. Run `pnpm typecheck`.

**LoC:** −20. **Parallel:** ✅ standalone.

### 3.4 — [x] Delete `engine/cache.ts` + inline single caller (Tier A.5) — XS

> Done 2026-05-19: removed `engine/cache.ts`; `docker-one-shot.ts` now yields `StateStore` directly
> and calls `store.get` / `store.put`. Also dropped the stale `cacheGet/cachePut/cacheRemove`
> re-export from `advanced/plugin-author/index.ts`.
>
> **Note (2026-05-19 docs pass):** A NEW `engine/cache.ts` was subsequently re-created later that
> day to host the `withCache(spec)` helper for the parallel-graph-resolution Phase C uniform cache
> discipline — see `notes/parallel-graph-resolution.md`. The new file shares the path but is a
> different abstraction (Cache-key contract with `verify` probe) and is unrelated to the deleted
> `cacheGet/cachePut/cacheRemove` shape. Both deletions (original) and re-introduction (new
> contract) are intentional.

**Files:**

- `packages/devstack/src/engine/cache.ts` — delete (~28 LoC).
- `packages/devstack/src/advanced/plugin-author/docker-one-shot.ts` — replace 2× `cacheGet` + 1×
  `cachePut` with direct `StateStore.get` / `StateStore.set` calls.

**Action:** The wrapper adds no semantic value over `StateStore`. Inline at the one caller.

**Evidence of need:** `synthesis/05` § 1, `synthesis/01-wrong-abstractions.md` F-05.

**LoC:** −28 net. **Parallel:** ✅ standalone (single caller; clean inline).

### 3.5 — [x] Rename engine `FaucetError` → `SuiHttpFaucetError`; mark internal — XS

> Done 2026-05-19: renamed class + tag string `FaucetError` → `SuiHttpFaucetError` in
> `engine/faucet.ts`, added `@internal` JSDoc; updated `services/account.ts`'s
> `catchTag('SuiHttpFaucetError')`, `engine/pretty-error.ts` comment, and `engine/faucet.test.ts`
> (identifier + assertions).

**File:** `packages/devstack/src/engine/faucet.ts:21`. **Action:**

- Rename `FaucetError` → `SuiHttpFaucetError`.
- Add `@internal` JSDoc tag.
- Remove from any inadvertent re-export (currently it's a dead export — `synthesis/05` §1).

**Evidence:** `round1/06-account-faucet.md` § 4.6, `round2/07-error-model.md` § 5.

**LoC:** ~5 (rename + JSDoc). **Parallel:** ✅ standalone.

### 3.6 — Wave-1 verification

Run
`pnpm --filter @mysten-incubation/devstack typecheck && pnpm --filter @mysten-incubation/devstack exec vitest run --exclude '**/*.docker.test.ts'`.
All five items should leave the test suite green and ~50 LoC net deleted.

---

## §4 Wave 2 — DeepBook + Postgres single-source-of-truth (Tier A.1 centerpiece)

**Recipe:** Two parallel subagents (deepbook stream + postgres stream). Each stream owns its
service + the grouper change in `runtime/service.ts`. **Gated by decisions §10.1 and §10.2.**

### 4.1 — [x] DeepBook stream — collapse endpoint-vs-state dual-write

> Done 2026-05-19: applied §10.1 default. Dropped `DEEPBOOK_INDEXER_METRICS` /
> `DEEPBOOK_SERVER_REST` / `DEEPBOOK_SERVER_METRICS` from `runtime/endpoint-names.ts`
> (declarations + `EndpointName` map), removed `publishEndpoint` calls from
> `services/deepbook/indexer.ts` + `services/deepbook/server.ts` (margin already had none),
> confirmed `groupDeepbook` already reads URLs from state-registries only. No callers of the three
> constants remained anywhere in src.

**Decision §10.1** (default: delete the endpoint declarations; state-registries own URLs):

If `delete`-direction wins:

#### 4.1.1 — Drop endpoint declarations

**File:** `packages/devstack/src/runtime/endpoint-names.ts`. **Action:** Remove
`defineEndpoint(...)` calls for `DEEPBOOK_INDEXER_METRICS`, `DEEPBOOK_SERVER_REST`,
`DEEPBOOK_SERVER_METRICS`. Remove from the `EndpointName` const map.

#### 4.1.2 — Remove `publishEndpoint` callers

**Files:** `packages/devstack/src/services/deepbook/indexer.ts`,
`packages/devstack/src/services/deepbook/server.ts`,
`packages/devstack/src/services/deepbook/margin.ts`. **Action:** Delete the three
`yield* publishEndpoint({...})` lines. Confirm state-registry already carries the URL (verified per
`round2/02-manifest-contract.md` § 2.B).

#### 4.1.3 — Update `groupDeepbook` consumer expectation

**File:** `packages/devstack/src/runtime/service.ts:145-180`. **Action:** No-op if the grouper
already reads from state-registry only (`round1/13-runtime-manifest.md` § 2.3 confirmed it does).
Just remove any dead-branch fallback that consulted endpoints.

#### 4.1.4 — Update tests

**File:** `packages/devstack/src/runtime/service.test.ts` — remove the three endpoint constants from
the `EndpointName constants` describe block (it currently locks 10; will lock 12 after Wave 6 adds
the missing 5; this removes 3 ⇒ net 7 deepbook-related, 9 total).

#### 4.1.5 — Update codegen consumer

**File:** `packages/devstack/src/codegen/emitters/deepbook-config.ts` — confirm it reads
`services.deepbook.indexer/server/margin.*` from manifest (not from endpoint registry). Should be no
change.

**LoC:** −30 to −50 net. **Parallel inside stream:** 4.1.1–4.1.5 are sequential within the stream
but the stream as a whole runs parallel with 4.2.

If `add`-direction wins (groupDeepbook consumes endpoint registry via `manifestLeafUnder`):

#### 4.1.alt-1 — Add `manifestField:` to the three endpoint declarations

#### 4.1.alt-2 — Rewrite `groupDeepbook` to use `manifestLeafUnder` like `groupSui` does

#### 4.1.alt-3 — Drop URL fields from `DeepbookIndexerStateRecord`, `DeepbookServerStateRecord`,

`DeepbookMarginStateRecord`

(Higher cost — touches more files. The default `delete` direction wins on `(cost × risk)`.)

### 4.2 — [x] Postgres stream — split password from public URL

> Done 2026-05-19: applied §10.2 Option-B default. `PostgresStateRecord` now carries `password` +
> plain `endpoint` (credentialed `url` field removed); `services/postgres.ts` publishes plain
> endpoint to both the endpoint-registry and state-registry (in-process `Postgres` shape still
> exposes the credentialed `endpoint` + `url(db)` accessor). `groupPostgres` is now a straight copy
> (no strip step); the no-credentials invariant is enforced at the registry shape, with a regression
> test in `runtime/service.test.ts`. `manifest-schema.ts` already omitted `password` — no change
> needed.

**Decision §10.2** (default: parse-and-strip in `groupPostgres`):

#### 4.2.1 — Settle the producer-side guarantee

**File:** `packages/devstack/src/services/postgres.ts:241-249`. **Action:** Decide producer shape:

- Option A: `state.endpoint` stays as full credentialed URL `postgres://user:pw@host:5432`. Grouper
  strips credentials before writing to manifest.
- Option B: `state.endpoint` is plain `postgres://host:5432`; password lives in a sibling
  `state.password` field; the credentialed URL is constructed on-demand by consumers that need it
  (deepbook indexer/server, via `postgres.url(db)` accessor).

Default: Option B. Cleaner: the manifest never carries the password, and the in-memory shape clearly
separates the two concerns.

#### 4.2.2 — Implement option-B split

**Files:** `packages/devstack/src/services/postgres.ts` (split fields),
`packages/devstack/src/engine/registries.ts` (update `PostgresStateRecord` schema),
`packages/devstack/src/runtime/manifest-schema.ts` (the `PostgresManifest.endpoint` field already
omits password; verify nothing changes).

#### 4.2.3 — Update `groupPostgres`

**File:** `packages/devstack/src/runtime/service.ts:193-205`. **Action:** Copy `state.endpoint`
(which is now plain) directly. Update comment to reflect that credentials are never in the
registry's `endpoint` field.

#### 4.2.4 — Test: assert manifest URL is plain

**File:** `packages/devstack/src/runtime/service.test.ts` (or `manifest-emit.test.ts`). **Action:**
Add a test that asserts `manifest.services.postgres.endpoint.url` does NOT contain `@` (a fast
no-credential check).

**LoC:** ~20 net. **Parallel inside stream:** sequential.

### 4.3 Wave-2 verification

Run docker-backed deepbook + postgres tests:

```
pnpm --filter @mysten-incubation/devstack exec vitest run 'src/services/deepbook/**/*.docker.test.ts'
pnpm --filter @mysten-incubation/devstack exec vitest run 'src/services/postgres.test.ts'
```

Then a full `pnpm test` once. Manually inspect
`examples/deepbook-full/.devstack/stacks/main/manifest.json` to confirm postgres URL is plain.

---

## §5 Wave 3 — Override-field fate + discriminator hygiene (Tier A.4 + B alignment)

**Recipe:** Four parallel subagents (deepbook, seal, walrus, pyth). Each subagent decides
per-service whether to (a) add a `kind:` discriminator + keep `override`, (b) drop `override`, or
(c) leave alone (status quo). **Gated by decision §10.3 (per-service override fate).**

### 5.1 — [x] Per-service override-field audit

> Done 2026-05-19: §10.3 default (drop where zero non-default setters) applied to all four.
> Whole-repo grep across `examples/`, `apps/`, and `packages/devstack/src/**/*.test.ts` confirmed
> **zero** `override:` setters on the `Walrus()` / `Seal()` / `Deepbook()` / `Pyth()` factory call
> sites. Removed the `override:` field from each Options interface, deleted the conditional dispatch
> path in each factory body, and replaced the call to the underlying primitive with the network-only
> canonical form. For Pyth this also collapses the `throw new Error('Pyth: \`override\` is required
> …')`branch — fork variants now resolve via`resolveDeploymentNetwork()`(matching the other three services), and missing canonical deployments throw a redirect to`pythKnownPackage({...})`on`/advanced`. Each Options block grew a comment pointing plugin authors at the underlying primitive on `/advanced`
> for private-deployment pinning.

For each of {Walrus, Seal, Deepbook, Pyth}:

1. Grep `examples/`, `packages/devstack/src/**/*.test.ts`, `apps/` (if any) for non-default setters
   of `override:` on the service's Options.
2. If zero non-default setters: **drop `override:`** from the Options type; remove the conditional
   dispatch path in the factory body; update tests; update AGENTS.md if it mentions override.
3. If ≥1 setter: **keep but add `kind:`** discriminator — `kind: 'local' | 'override'` — so the
   Options type narrows correctly. Migrate existing setters.

**Files (per service):**

- **Walrus**: `services/walrus.ts`, `services/walrus/internal.ts` (grandfathered LoC — only touch
  the Options interface + dispatch site, not the bulk logic).
- **Seal**: `services/seal.ts`, `services/seal/internal.ts` (same caveat — grandfathered).
- **Deepbook**: `services/deepbook.ts`, `services/deepbook/local-deploy.ts`,
  `services/deepbook/internal.ts`.
- **Pyth**: `services/pyth.ts`, `services/pyth/local-deploy.ts`, `services/pyth/known-package.ts`.

**Evidence of need:** `synthesis/01-wrong-abstractions.md` F-01,
`round3/03-options-configuration.md` § "Always-default fields".

**Parallel:** ✅ 4-way. **LoC:** −10 to +30 net depending on per-service decision.

### 5.2 — [x] Sui `network:` decision (Tier A.3 / F-03)

> Done 2026-05-19: §10.5 default (grandfather forever) applied. No code change to `Sui()` dispatch.
> Added a load-bearing JSDoc block on `SuiOptions.network` in `services/sui.ts` documenting the
> grandfathered exception to AGENTS.md's `kind:` discriminator convention (cites synthesis F-03 +
> this §10.5 settle). The note explains the rationale (`network:` doubles as input +
> resolved-output; renaming would break a published API for marginal type-safety gain) so future
> agents reading the file don't re-flag it.

**Decision §10.5.** Default: leave Sui alone; document grandfathering more visibly in AGENTS.md §
"Service factory shape". A migration to `kind:` would break a published API for marginal value.

If decision says migrate: add `kind:` accepted as alias for `network:` at the parser; deprecate
`network:` over the next major. Touches `services/sui.ts` and ~3 example configs. **Not done by
default.**

### 5.3 — [x] Auto-mount string-prefix detection check

> Done 2026-05-19: verified. `compose/defaults.ts:28` does
> `((r as { key?: string }).key ?? '').startsWith('faucet/')`; `services/faucet/index.ts:199`
> constructs the tag key as `` `faucet/${name}` ``. Wave 5 stream-5B hasn't shipped any
> discriminator changes that affect this key shape, and the existing
> `compose/devstack.test.ts > 'honors a custom-named user Faucet'` test continues to exercise the
> `name: 'custom'` dedup path. No edits needed.

**File:** `packages/devstack/src/compose/defaults.ts:26-35`. **Action:** Re-verify the `'faucet/'`
tag-key prefix check still works after Wave 5's potential discriminator changes. Trivial; no edits
expected.

### 5.4 Wave-3 verification

`pnpm typecheck && pnpm test` per service. Confirm examples that already used localnet defaults
don't break.

---

## §6 Wave 4 — Documentation rollout (Tier B.1 + B.4 + AGENTS.md cross-refs)

**Recipe:** 5-way fan-out for `Snapshot participation:` docstrings + 1 sweep agent for span-name
batch + 1 agent for AGENTS.md cross-references. All file-disjoint; fully parallel.

### 6.1 — [x] `Snapshot participation:` docstring rollout (Tier B.1)

> Done 2026-05-19: applied the 3-bullet template (matches AGENTS.md § "Snapshot participation") as a
> top-of-file comment to all 6 container-backed services in the rollout list. Per-file:
> `services/sui.ts` (covers localnet RocksDB + per-fork `meta.json` + indexer-postgres sidecar + the
> testnet/mainnet vacuity), `services/walrus/local-cluster.ts` (deploy fingerprint, per-node
> container layers carrying BLS keys, nginx proxy config), `services/seal/internal.ts` (BLS keypair
> in state-store, on-chain `KeyServer` object id, `runtime/seal/master-key.env`),
> `services/postgres.ts` (writable `/pgdata` layer, ensured-databases state-store entry — references
> the Wave 2 §10.2 Option-B password split), `services/deepbook.ts` (delegates per-branch to
> `local-deploy.ts` and the known-package branch), `services/deepbook/local-deploy.ts` (package +
> adminCap publish outputs, `StateStoreKeys.deepbookPools(...)` cache, market-maker order-book
> caches as the intentional-loss item).
> `grep -rn 'Snapshot participation' packages/devstack/src/services/` now hits 10 (the 6 added + 4
> pre-existing in `wallet.ts`, `faucet/index.ts`, `deepbook/indexer.ts`, `deepbook/margin.ts`).
> `pnpm --filter @mysten-incubation/devstack typecheck` green; fast vitest pass for the touched
> modules (6 + 6 test files) green.

Apply uniform docstring (template in AGENTS.md § "Snapshot participation") to each container-backed
service. Format (matches AGENTS.md):

```ts
/**
 * Snapshot participation:
 *  - **What this service persists:** <state-store keys, runtime/<svc>/ files, container writable layers>
 *  - **What re-derives from on-chain state on apply:** <cached deploy outputs keyed by source-hash + chainId>
 *  - **What is intentionally lost on snapshot restore:** <account balances if not re-fauceted; in-memory caches>
 */
```

**Files (5-way fan-out, one subagent per service):**

- 6.1.1 — `services/sui.ts` (top-of-file): RocksDB at `/root/.sui` (writable layer); per-fork data
  dir + meta.json; indexer postgres sidecar; chain state survives via container retag.
- 6.1.2 — `services/walrus.ts` or `services/walrus/local-cluster.ts`: walrus deploy fingerprint
  (state-store), node configs, container writable layers (BLS keys).
- 6.1.3 — `services/seal/internal.ts`: BLS keypair (state-store + runtime/seal/master-key.env),
  on-chain key-server object id.
- 6.1.4 — `services/postgres.ts`: `/pgdata` writable layer (Wave 4 caveat: requires the postgres
  password split in Wave 2 to be decided first; reference Option-B shape).
- 6.1.5 — `services/deepbook.ts` and (if applicable) `services/deepbook/local-deploy.ts`: publish
  outputs (state-store), pool registry IDs, indexer/server postgres tables.

**Note:** Some of these may overlap with `notes/post-launch-sweep.md` § 3.4 if that work hasn't
shipped yet. Coordinate with anyone running that plan.

**Evidence of need:** `round1/03-sui-fork-snapshot.md` § 4 (CRITICAL FINDING),
`round3/01-state-persistence.md` § 7, AGENTS.md § "Snapshot participation".

**LoC:** +30 to +50 (docs only). **Parallel:** ✅ 5-way.

### 6.2 — [x] Span-name PascalCase batch (Tier B.4)

> Done 2026-05-19: swept every `Effect.withSpan(...)` callsite in `packages/devstack/src/**` to
> PascalCase. Renamed all 36 catalogued violations from `round3/04-observability.md` § 1 (kebab-case
> / dot-separated camelCase: `manifest.write` → `ManifestWrite`, `sui.probe.rpc` → `SuiProbeRpc`,
> `deepbook.create-pools` → `DeepbookCreatePools`, `seal(name).rotate` → `SealRotate(name)`,
> `walrus.seed-accounts.${name}` → `WalrusSeedAccounts(${name})`, `sui.fork.autoTick.tick` →
> `SuiForkAutoTickTick`, etc.) plus the 14 "Mixed case" templated callsites flagged as
> borderline-compliant (`deepbookMargin(${name})` → `DeepbookMargin(${name})`, `pythKnownPackage` →
> `PythKnownPackage`, `walletApp(${name})` → `WalletApp(${name})`, `dockerContainer(${name})` →
> `DockerContainer(${name})`, `codegen(${name})` → `Codegen(${name})`, etc.). Final state: 0
> lowercase-leading `Effect.withSpan` names across the package. Convention: PascalCase
> service-domain phrases; dots retained only when both sides are PascalCase namespaces
> (`Docker.pull`, `StateStore.put`, `Devstack.launch`, `Tui.startOnce` — kept as-is per the
> "Compliant" catalog rows). `Effect.fn(...)` span labels (separate API, e.g. `seal(${name})`,
> `suiLocalnet`, `walrus.image`) were deliberately left out of scope — the catalog and §6.2 plan
> both scoped to `withSpan`. Observability.ts header comment updated to reflect post-batch state.
> Typecheck green; 774 tests passing (1 pre-existing failure in `coin/discovery.docker.test.ts` is
> an unrelated docker-env coin witness issue with no span references). No test assertions checked
> span names by string, so no test drift to fix.

**Files (1 sweep agent):** every file using `Effect.withSpan(...)` with a kebab-case or snake_case
name. `round3/04-observability.md` § 1 catalogs 36 of 96 sites violating PascalCase.

**Action:** Mechanical rename to PascalCase (`manifest.write` → `ManifestWrite`, `sui.probe.rpc` →
`SuiProbeRpc`, `deepbook.create-pools` → `DeepbookCreatePools`, etc.). Keep service-domain prefix;
capitalize per word.

**AGENTS.md note:** current policy is "migrate as files are touched." This wave overrides with a
one-shot sweep. Confirm with maintainer (decision §10 — already noted in the master REVIEW Tier B.4
as "By deletion / batch — recommend batch since it's a small finite set").

**LoC:** ±0 (renames). **Parallel:** ✅ standalone (single sweep agent, large diff).

### 6.3 — [x] AGENTS.md cross-references + clarifications (Tier A.5 housekeeping) — partial

> Partial done 2026-05-19 — AGENTS.md portion landed; two sub-items deferred to separate passes as
> noted below.
>
> **Done:** Added a new `### Test harnesses (`testkit` files)` sub-section under "Running tests —
> fast vs. slow" in `packages/devstack/AGENTS.md` documenting the `*.testkit.ts` vocabulary
> (non-test test harness; boots real infra; not picked up by the `*.test.ts` glob; current example
> is `engine/sui-fork.testkit.ts`). Verified the existing architecture-writeup cross-ref at line 14
> (`Background reading: .review-findings/synthesis/00-architecture.md`) is still valid — no edit
> needed. Confirmed the `Snapshot participation:` template is already formally documented in
> AGENTS.md (the existing `## Snapshot participation` section at line 432) — no edit needed.
>
> **Deferred (separate later passes):**
>
> - `runtime/endpoint-names.ts` inline comment for `SUI_CHECKPOINT_VOLUME` — file was reserved for a
>   parallel agent in this wave; will be picked up in a follow-up touch when an agent owns that
>   file.
> - ~~`pyth/internal.ts → pyth/shared.ts` rename~~ — [x] done 2026-05-19. `git mv` of
>   `services/pyth/internal.ts` → `services/pyth/shared.ts` + import-path updates in 7 importers
>   (index.ts, mid.ts, known-deployment.ts, tag.ts, local-deploy.ts, local-deploy.test.ts,
>   pusher.ts). `services/pyth.ts` already imported through `./pyth/index.js` so no edit there.
>   `pnpm --filter @mysten-incubation/devstack typecheck` green; pyth unit tests (2 files, 3 tests)
>   green.

**File:** `packages/devstack/AGENTS.md`. **Actions:**

- Document the `testkit` vocabulary used in `engine/sui-fork.testkit.ts` (per `round1/03` § 5).
- Add an inline comment in `runtime/endpoint-names.ts` clarifying `SUI_CHECKPOINT_VOLUME` is
  intentionally flat-only (no `manifestField:`, no `conventional:`).
- Cross-reference the architecture writeup at `.review-findings/synthesis/00-architecture.md` in
  AGENTS.md header (it already does — verify still valid).
- Rename `pyth/internal.ts` → `pyth/shared.ts` or `pyth/feed-helpers.ts` (per
  `round1/10-pyth-postgres.md` § 4.6 — violates the "internal.ts XOR concern-modules" rule).
- Document the `Snapshot participation:` template formally in AGENTS.md if not already (it is — just
  confirm).

**LoC:** +30 docs / ±0 rename. **Parallel:** ✅ standalone.

### 6.4 Wave-4 verification

`pnpm test` for the 5 services that got docstrings (no behavior change expected). Visual diff the
AGENTS.md update. Spot-check that `grep -r 'Snapshot participation:' packages/devstack/src/services`
returns 5 hits where it used to return 0.

---

## §7 Wave 5 — Typed errors + known-package consolidation (Tier B.2, B.6)

**Recipe:** Two streams. Stream 5A introduces new typed errors. Stream 5B consolidates the four
`known-package.ts` files. Stream 5A is small; Stream 5B is **gated by decision §10.6** (rename vs
fold).

### 7.1 Stream 5A — [x] Typed errors for non-core throws (Tier B.2)

> Done 2026-05-19: added `ManifestDiscoveryError` (phases: `walk-up`, `required-missing`) and
> `ConfigLoadError` (phases: `load`, `validate`, `missing-default-export`, `invoke`) to
> `engine/errors.ts`; closed-set `Schema.Literals` per AGENTS.md. Migrated 12 throw-sites total — 3
> in `runtime/discover-manifest.ts` (→ `ManifestDiscoveryError`), 2 in `cli/loaders.ts`
> `requireLaunchEffect` / `requireLayer` plus 1 `Effect.fail` site inside `loadConfigModule` (→
> `ConfigLoadError`), and 7 in `advanced/plugin-author/git-fetch.ts` validators (→ existing
> `GitFetchError`). The 1 throw in `cli/commands/fork.ts` (`resolveForkRuntimeCtx` inside
> `Effect.tryPromise.try`) was left unmigrated — file outside this stream's reserved set, and the
> orchestrator's parallel-fork-agent owns those throw-sites. New errors re-exported from the package
> root and added to the `engine/errors.test.ts` conformance catalog; new unit tests cover at least
> one phase variant of each new error plus the `GitFetchError` rejection paths (`git-fetch.test.ts`
> newly created).

#### 7.1.1 — Add `ManifestDiscoveryError`, `ConfigLoadError`

**File:** `packages/devstack/src/engine/errors.ts`. **Action:** Two new `Schema.TaggedErrorClass`
definitions with closed `Schema.Literals` phase fields (per AGENTS.md). Suggested phases:

- `ManifestDiscoveryError.phase`: `'walk-up' | 'parse' | 'validate' | 'required-missing'`.
- `ConfigLoadError.phase`: `'load' | 'invoke' | 'validate' | 'missing-default-export'`.

Re-export from package root (`src/index.ts`) so users can `catchTag` them.

#### 7.1.2 — Migrate 15 `throw new Error(...)` callsites

**Files (per `round2/07-error-model.md` § 6):**

- `packages/devstack/src/advanced/plugin-author/git-fetch.ts`
- `packages/devstack/src/runtime/discover-manifest.ts`
- `packages/devstack/src/cli/loaders.ts`
- Fork-admin callers (per `round1/03-sui-fork-snapshot.md` open question)

Each throw becomes `yield* Effect.fail(new XError({phase: '...', ...}))`. Add tests for at least one
phase variant of each new error.

**LoC:** +60 / −30. **Parallel inside stream:** 7.1.1 → 7.1.2 sequential.

### 7.2 Stream 5B — [x] `known-package.ts` consolidation (Tier B.6)

> Done 2026-05-19: applied §10.6 default (rename). `git mv` renamed
> `services/deepbook/known-package.ts` → `services/deepbook/known-deployment.ts` and
> `services/pyth/known-package.ts` → `services/pyth/known-deployment.ts` (plus the matching
> `known-package.test.ts` → `known-deployment.test.ts`). Updated the two barrels
> (`services/deepbook/index.ts`, `services/pyth/index.ts`) and the renamed test's import. The
> exported factory names (`deepbookKnownPackage`, `pythKnownPackage`) and option-type names stay the
> same — only file paths changed. The root `services/known-package.ts` (distinct `KnownPackage`
> factory) and the already-disambiguated `services/walrus/known-deployment.ts` were untouched per
> the plan. Updated the `notes/deepbook-plugin-expansion.md` cross-reference; AGENTS.md doesn't
> mention the old names, so no edit there.

**Files (4 candidates):**

- `packages/devstack/src/services/known-package.ts` (root KnownPackage factory — distinct concept;
  not consolidated)
- `packages/devstack/src/services/deepbook/known-package.ts`
- `packages/devstack/src/services/pyth/known-package.ts`
- `packages/devstack/src/services/walrus/known-deployment.ts` (already disambiguated by name)

**Decision §10.6** (default: rename):

If `rename`-direction wins:

- `services/deepbook/known-package.ts` → `services/deepbook/known-deployment.ts`
- `services/pyth/known-package.ts` → `services/pyth/known-deployment.ts`
- Update barrel imports + any callsites
- Update AGENTS.md if it references the old names

If `fold`-direction wins:

- Inline each per-service `known-package.ts` content into the service's `index.ts` or barrel
- Delete the files
- Cost: larger diff, higher risk of confusion if a future service wants its own known-deployment

**LoC:** ~10 (rename) or −80 (fold). **Parallel inside stream:** all 3 per-service edits run in
parallel.

### 7.3 Wave-5 verification

`pnpm typecheck && pnpm test`. Verify `engine/errors.ts` exports the two new classes and they're
re-exported from root.

---

## §8 Wave 6 — Removal sweep (Tier A.5 + `synthesis/05` full list)

**Recipe:** Multi-stream parallel. Each item is file-disjoint. **Gated by decisions §10.4
(dockerOneShot/hostScript), §10.7 (setupDevstack/withDevstack), §10.8 (TUI types).**

### 8.1 — [x] `vitest/withDevstack` decision (decision §10.7 part 1)

**File:** `packages/devstack/src/vitest/index.ts`. **Action (default: delete):** Remove
`withDevstack` export. Or move to `vitest/_experimental.ts` if maintainer wants to keep the API
discoverable for future plugin use.

Whole-repo grep (`synthesis/05` §1) confirmed zero callers in examples + tests.

**Completed 2026-05-19.** Took the default — deleted the `withDevstack` export from
`src/vitest/index.ts`; the subpath now exports only `defineDevstackVitestConfig`. Module header
documents the bare `it.layer(handle.layer)` pattern users reach for. The `define-config.ts`
docstring was updated to drop the `withDevstack` reference. Example `vitest.config.ts` files still
have stale doc-comments mentioning `withDevstack` — left as documentation rot rather than break the
example file-disjoint constraint; will catch on next examples sweep.

### 8.2 — [x] `playwright/setupDevstack` decision (decision §10.7 part 2)

**File:** `packages/devstack/src/playwright/setup-devstack.ts`. **Action (default: delete):** Remove
the export. The supervisor's `Dev()` service is the actual boot path; `setupDevstack` represents a
hypothetical "Playwright-independent stack lifecycle" that no example uses.

Alternative: ship an example that demonstrates the value (would justify keeping).

**Completed 2026-05-19.** Took the default — deleted `setup-devstack.ts` + its co-located test file;
removed the `setupDevstack` / `DevstackPlaywrightFixture` re-exports from `playwright/index.ts` and
updated the barrel header to drop the escape-hatch reference. The supervisor's `Dev()` LayeredTag
remains the canonical Playwright-driving surface (via `defineDevstackPlaywrightConfig`).

### 8.3 — [x] Move `pythMid` from root to `/advanced` only

**Files:**

- `packages/devstack/src/index.ts` — remove `pythMid` re-export.
- `packages/devstack/src/advanced/index.ts` — add `pythMid` re-export (or confirm already there).

**Evidence:** `round2/08-public-api-ergonomics.md` § 4 — `pythMid` exported from root but never used
by examples; it's an internal helper consumed by `DeepbookMarketMaker`.

**LoC:** ±0. **Parallel:** ✅ standalone.

**Completed 2026-05-19.** Removed `pythMid` from the root barrel; added explicit
`{ pythMid, PythMid, PythMidOptions, PythMidScale }` re-exports to `advanced/index.ts` with a
docblock pointing plugin authors at the `DeepbookMarketMaker`-composes-it-internally pattern.
Public-API pin-test (`src/index.test.ts::PUBLIC_EXPORTS`) updated to drop the entry.

### 8.4 — [x] TUI types decision (decision §10.8)

**Files:** `packages/devstack/src/engine/tui-state.ts`, `packages/devstack/src/index.ts`. **Action
(default: promote to internal):** Move TUI types (`TuiState`, `TuiEntry`, `TuiHeader`, status enums)
behind a non-public import path. Confirm no example reaches for them.

Alternative: add to `/advanced` if plugin authors writing custom renderers need them.

**Completed 2026-05-19.** Confirmed via repo-wide grep that no `TuiState` / `TuiEntry` / `TuiHeader`
/ `TuiEntryKind` / `TuiEndpoint` / `TuiLog` / `TuiDimensions` type is exported from `src/index.ts`
or `src/advanced/index.ts`; only `tui/*` + `engine/*` modules import from `engine/tui-state.ts`.
Added a header note in `engine/tui-state.ts` formalizing the "internal-only" decision so a future
contributor doesn't promote a type without re-reading §8.4 + §10.8 first.

### 8.5 — [x] Resolve `SUI_CHECKPOINT_VOLUME` orphan

**File:** `packages/devstack/src/runtime/endpoint-names.ts:113-116`. **Action:** Add a
`manifestField:` OR delete the declaration entirely. Default: add a comment clarifying it's
intentionally flat-only-internal (covered in Wave 4.3 if that landed first; if so, this item is
satisfied).

**Completed 2026-05-19.** Took the default — added a 10-line clarifying comment above the
`sui_checkpoint_volume` declaration explaining the no-`manifestField:` / no-`conventional:` shape is
intentional (it addresses a Docker volume rather than an HTTP endpoint) and that the constant is
reserved for the deepbook-indexer ↔ sui-fork wiring in `notes/sui-fork-integration.md`. Wave 4.3's
AGENTS.md cross-reference task didn't add this comment, so it landed here.

### 8.6 — [x] Complete dev-server PRIMARY/FALLBACK migration

**Files:**

- `packages/devstack/src/runtime/endpoint-names.ts:61-77` (delete `dev_server_fallback`
  declaration).
- `packages/devstack/src/services/dev.ts` — change Dev() to publish PRIMARY (`frontend.dev-server`)
  not FALLBACK (`dev-server`).
- `packages/devstack/src/runtime/service.ts::groupApp` — remove FALLBACK fallback branch (lines
  ~212-213).

**Evidence:** `round1/13-runtime-manifest.md` § 4.3.

**LoC:** −20. **Parallel:** ✅ standalone; touches files no other Wave 6 item touches.

**Completed 2026-05-19.** Done in two passes. (1) Earlier pass flipped `Dev()` to publish under
`EndpointName.DEV_SERVER_PRIMARY` (`frontend.dev-server`) and removed the second FALLBACK publish
from `services/dev.ts`. (2) This pass finished the cleanup: the `dev_server_fallback` declaration
was already gone from `runtime/endpoint-names.ts`, `runtime/service.ts::groupApp` already reads only
`DEV_SERVER_PRIMARY`, and the `EndpointName constants` describe block in `runtime/service.test.ts`
already lists only `DEV_SERVER_PRIMARY`. The load-bearing remaining work was migrating
`playwright/web-server.test.ts` — its six tests still passed the literal `'dev-server'` endpoint
string into `webServer()`/`baseURL()`, which now fails because the manifest projection emits
`frontend.dev-server` only. Switched all six call sites to `EndpointName.DEV_SERVER_PRIMARY`;
cold-start fallback works because `defineEndpoint(dev_server_primary)` already carries
`conventional: {service: 'dev', port: 5175}`. `playwright/define-config.ts` and
`playwright/web-server.ts` already defaulted/documented around `DEV_SERVER_PRIMARY`.
`services/dev.test.ts` line 158 uses the literal string `'dev-server'` as an arbitrary
`hostProcess`-level endpoint name (not a constant reference) and is unaffected. Verified:
`pnpm --filter @mysten-incubation/devstack typecheck` clean; `playwright/web-server.test.ts` 10/10
pass; full non-docker `pnpm test` suite 722/722 pass (the two unrelated failures are
`cli/commands/prune.test.tsx` Ink TUI timeout and `services/coin/discovery.docker.test.ts`, both
pre-existing and not touched here).

### 8.7 — [x] `AccountSpec.keystore` variant: test OR remove (decision §10.9 implicit, can decide ad-hoc)

**Files:**

- `packages/devstack/src/services/account.ts:162-169` (the keystore branch).
- `packages/devstack/src/services/account.test.ts` (no keystore tests today per `round1/06` § 5).

**Default: add test coverage.** Reading from `~/.sui/sui_config/sui.keystore` is a common path on
CI; deletion would lose value.

Alternative: if no consumer is known and team prefers a smaller surface, delete the variant.

**Completed 2026-05-19.** Took the default — added three `kind: 'keystore'` tests to
`services/account.test.ts`:

- **alias-resolution happy path** — writes a real `sui.keystore` + `sui.aliases` pair to a tmpdir,
  with `flag||pubkey` base64 encoding on the alias side, and asserts
  `Account('alice', {kind: 'keystore', alias: 'alice', path})` resolves to the expected ED25519
  address;
- **address-fallback path** — keystore-only (no `.aliases` sibling), passes the on-chain address as
  `alias:`, asserts the loop falls through to address matching;
- **error path** — keystore present but alias missing, asserts the typed `AccountError` with
  `phase: 'load-key'` and a `no entry matching alias/address` message.

All three pass under `vitest run src/services/account.test.ts -t keystore`.

### 8.8 — [x] `dockerOneShot` + `hostScript` re-evaluation (decision §10.4)

**Files:** `packages/devstack/src/advanced/plugin-author/docker-one-shot.ts`,
`packages/devstack/src/advanced/plugin-author/host-script.ts`. **Action (default: keep with
sunset):** Add a JSDoc note: "Public escape hatch for plugin authors; zero in-tree callers; will be
re-evaluated for removal in 6 months if no caller appears."

Alternative: delete now. Risk: forecloses on plugin-author use cases.

**Completed 2026-05-19.** Took the default — added an export-level JSDoc block to `dockerOneShot`
(in `advanced/plugin-author/docker-one-shot.ts`) and `hostScript` (in
`advanced/plugin-author/host-script.ts`) documenting them as "public escape hatch for plugin
authors", noting zero in-tree callers as of Wave 6.8, and pinning the sunset date to **2026-11-19**
(six months out). Out-of-tree plugin authors are pointed at filing an issue with their use case so
the sunset can be cancelled before the date.

### 8.9 Wave-6 verification

`pnpm test`. Spot-check each example app still builds and its e2e suite passes (only the
deepbook-full and arena examples typically exercise the removed surface).

---

## §9 Wave 7 — Housekeeping (Tier C, lazy-during-touch)

**Recipe:** Loose parallel; opt-in. None of these are urgent. Lazy-during-touch means: when a
contributor edits a nearby file, they pick up the housekeeping item too.

### 9.1 — Inline `display-path.ts` IF a fourth `writeIfChanged` site appears

Lazy. Today `display-path.ts` has one caller (codegen factory); inlining is fine when the next
contributor naturally touches both.

### 9.2 — [x] Nested-project `discoverManifestPath` test

> Done 2026-05-19: added a `nested-project walk-up` describe block to
> `runtime/discover-manifest.test.ts` with a shared `setupNestedLayout()` helper that writes an
> outer `<tmp>/.devstack/stacks/main/manifest.json` and an inner
> `<tmp>/apps/nested/.devstack/stacks/main/manifest.json`. Two cases: (1) cwd at
> `<inner>/src/feature` resolves to the inner manifest (documented "closest wins" semantics of the
> walk-up); (2) cwd at `<tmp>/apps/other` (sibling of the inner project, still under the outer root)
> resolves to the outer manifest. Both cases align with the limitation noted in
> `round1/13-runtime-manifest.md § 4.10` — users that need to reach across nesting use
> `DEVSTACK_MANIFEST_PATH` or `override:`.
> `pnpm --filter @mysten-incubation/devstack exec vitest run src/runtime/discover-manifest.test.ts`
> green (13 tests).

**File:** `packages/devstack/src/runtime/discover-manifest.test.ts`. **Action:** Add a test for
walk-up behavior in a nested-project layout (outer + inner `.devstack/stacks/main/manifest.json`).
Asserts walk-up finds outer if cwd is below inner. **Evidence:** `round1/13-runtime-manifest.md` §
4.10.

### 9.3 — Span-coverage gap audit

After Wave 4.2's PascalCase batch lands, re-audit which primitives lack a top-level
`Effect.withSpan` (per `round3/04-observability.md` § 8). Add spans where missing.

### 9.4 — [x] `cli/commands/_prune-stack.ts` underscore convention

> Done 2026-05-19: confirmed via `find packages/devstack/src -name '_*.ts'` that
> `cli/commands/_prune-stack.ts` is the **only** underscore-prefixed source file in the package
> today. Took option (a) per the plan — added an
> `### Underscore-prefixed files (\`_\*.ts\`)`subsection under "CLI conventions" in`packages/devstack/AGENTS.md`documenting the`_\*.ts`
> convention as "helper module, not a registered command", citing the current sole example, and
> asking future contributors to keep the prefix grep-able. No rename — keeps the lower-risk path the
> plan prefers.

**File:** `packages/devstack/src/cli/commands/_prune-stack.ts`. **Action:** Add an AGENTS.md note
documenting the `_*.ts` convention ("helper module, not a registered command") if used elsewhere. Or
rename and resolve. **Evidence:** `round1/15-cli.md` § 4 / `round2/04-cli-engine-tui.md` § 8.

### 9.5 — Renderer TTY heuristic documentation

**File:** `packages/devstack/src/engine/renderer.ts` (and supervisor renderer factory wiring).
**Action:** Document where the tui/plain dispatch happens (the original claim was TTY-based but no
TTY check was found per `round2/04` § 3). Add a one-line comment at the dispatch site.

### 9.6 — Snapshot atomicity defensive layer

**File:** `packages/devstack/src/engine/snapshot.ts:353-565`. **Action:** Consider wrapping snapshot
create in a `.snapshot-in-progress/` subdir + atomic rename on success (per `round1/03` § 4.7).
Currently graceful but not atomic. **Lazy** — only if a contributor touches snapshot code for
another reason.

### 9.7 — `~/.devstack/registry.json` lock

**File:** `packages/devstack/src/engine/registry.ts`. **Action:** Add a lock to the global
machine-wide registry write (per `round3/01-state-persistence.md` § 10). Currently writes are
race-vulnerable across concurrent supervisors. **Lazy** — incidence is low; only an issue under
heavy parallel agent fan-out.

---

## §10 Wave 8 — Decisions needed before kickoff

These gate Waves 2, 3, 5, 6. Maintainer review required. **Default recommendations in parentheses**
for fast settling.

### §10.1 — DeepBook URL ownership (gates Wave 2.1)

**Question:** Should the manifest's `services.deepbook.indexer.metrics` /
`services.deepbook.server.rest` URLs come from endpoint-registry declarations (via
`manifestLeafUnder`) or from state-registry fields directly?

**Default: delete the endpoint declarations.** State-registries already own the URLs; grouper
already reads from them. The endpoint declarations are vestigial.

**Trade-off:** keeping endpoints would enable conventional-route cold-start fallback for those URLs
(currently absent). If you want Playwright to be able to hit deepbook indexer before supervisor
writes the manifest, you'd want the endpoint route. Otherwise delete.

### §10.2 — Postgres password split (gates Wave 2.2)

**Question:** Should `PostgresStateRecord` carry the full credentialed URL (and groupPostgres
strip), or should the state record hold the plain URL + a sibling password field?

**Default: split (Option B).** Cleaner separation; the manifest never carries the password by
construction; consumers needing credentials use `postgres.url(db)` which constructs on-demand.

### §10.3 — Override-field fate (per service; gates Wave 3.1)

**Question:** For each of Walrus, Seal, Deepbook, Pyth — does the `override:` field have any
non-default setter in examples + tests?

**Default decision rule:** drop where zero non-default setters; add `kind:` discriminator where ≥1
setter. Per-service answer requires a grep audit (Wave 3.1 step 1).

### §10.4 — `dockerOneShot` + `hostScript` keep-vs-sunset (gates Wave 6.8)

**Default: keep with sunset.** Add 6-month sunset note in JSDoc; re-evaluate at sunset date if no
caller has appeared.

### §10.5 — Sui `network:` discriminator: grandfather forever or deprecation path (gates Wave 3.2)

**Default: grandfather forever.** Document the exception more visibly in AGENTS.md. Migration is a
breaking API change for marginal type-safety gain.

### §10.6 — `known-package.ts` rename vs fold (gates Wave 5.3)

**Question:** Rename per-service `known-package.ts` to `known-deployment.ts` (disambiguate from root
factory), or fold into service barrels?

**Default: rename.** Lower-risk; the per-service files are stable feature points.

### §10.7 — `setupDevstack` / `withDevstack`: example or delete (gates Wave 6.1, 6.2)

**Default: delete.** Both are well-implemented but zero-used. If a use case is real, an example
should ship first.

### §10.8 — TUI type exports — promote-to-public or hide-internal (gates Wave 6.4)

**Default: hide internal.** No example reaches for them; plugin authors writing custom renderers can
be re-exposed in `/advanced` if a real consumer emerges.

### §10.9 — `AccountSpec.keystore` variant test or remove

**Default: add test.** Keystore is a common CI path.

### §10.10 — Branded types sweep for endpoint name strings, state-store keys, span names

**Default: defer.** Larger pre-release work item. List in §11 deferrals.

### §10.11 — Snapshot version bump cadence

**Default: clean break per AGENTS.md.** No fallback decoder when v5 ships. Mention in AGENTS.md §
"Breaking changes are fine" if not already.

### §10.12 — Intermediate example apps (beginner-deepbook, custom-Codegen-emitter, custom-Faucet-strategy)

**Default: defer to a separate plan.** Each example is a multi-day undertaking; not Tier A/B/C debt.

---

## §11 Items intentionally STAY (not actionable; documented to prevent re-discovery)

Synthesis/03 surveyed all duplications and found that most are intentional. Document so future
agents don't re-discover and propose work:

- **Lock patterns** — `engine/file-lock.ts`, `engine/sui-fork/file-lock.ts`, `engine/state-store.ts`
  use three different shapes for legitimate reasons (sync vs Effect retry; instanceId-bearing vs
  not). STAY.
- **`writeIfChanged` async/sync split** — canonical async in `engine/atomic-write.ts`; sync in
  `codegen/helpers.ts`. Different contexts justify the split. STAY (single canonical async, three
  callers via shared helper). Note: if Wave 1 inline shipped, `codegen/helpers.ts::writeIfChanged`
  is the single sync impl — also fine.
- **Sibling Dockerfiles** (sui-image, walrus-image, seal-image, postgres-image, sui-fork-image)
  share 95% identical release-fetch blocks. **Intentionally NOT consolidated** per design comment in
  each Dockerfile (avoids cache-key coupling that would break independent rebuilds). STAY.
- **Per-example `dapp-kit.ts` boilerplate** — six React examples have identical `src/dapp-kit.ts`.
  This is by-design copy-paste templating. STAY.
- **`publishXState` helpers** — 9 service-state registries each have their own `publishX` helper,
  already factored via `defineRegistry`. Not "duplication." STAY.
- **Per-service `known-package.ts` files** (after Wave 5.3 rename, they become
  `known-deployment.ts`) — each has a different state shape; not unifiable.
- **Per-service `internal.ts` files** for grandfathered services (`services/sui.ts`,
  `services/account.ts`, `services/seal/internal.ts`, `services/walrus/internal.ts`) — AGENTS.md
  grandfathers their size explicitly. STAY.

---

## §12 Items DEFERRED (out-of-scope for this plan; tracked for future)

- **Branded types sweep** for endpoint name strings + state-store keys + span names + service names.
  Pre-release work item; touches ~50 files; deserves its own plan.
- **New example apps** (per §10.12): beginner-deepbook, custom-Codegen-emitter,
  custom-Faucet-strategy. Each is 200–500 LoC of scaffolding; deserves its own plan.
- **`@mysten/sui` Signer abstract class adoption** for Account — already tracked in
  `notes/post-launch-sweep.md` Wave 2 (item Q7). Don't duplicate here.
- **Grandfathered monolith refactors** (`services/sui.ts`, `services/account.ts`,
  `services/seal/internal.ts`, `services/walrus/internal.ts`) — AGENTS.md explicitly grandfathers;
  out of scope.
- **Snapshot create atomicity** (`.snapshot-in-progress/` + atomic rename) — currently graceful but
  not atomic. Lazy-during-touch (Wave 7.6).
- **`~/.devstack/registry.json` lock** — race-vulnerable but incidence low. Lazy-during-touch (Wave
  7.7).
- **Codegen fingerprint cache** scope (currently module-local Map by outputDir) — only matters if a
  second emitter needs fingerprinting. Speculative; defer.

---

## §13 False positives caught during synthesis (do NOT re-flag)

Phase 1 agents are scoped to one component each and may have miscalled "dead". The synthesis pass
re-verified each candidate with whole-repo grep. The following items survived the re-check; they are
alive. Future agents reading Phase 1 reports should know:

- **`engine/docker/exec.ts::restartContainer`** — Phase 1 (round1/02 § 4) said zero callers.
  Whole-repo grep finds it used by `seal/internal.ts`. ALIVE.
- **`engine/safe-env.ts`** — Phase 1 (round1/01 § 4.1 Finding 2) said no imports. Whole-repo grep
  finds it used by `advanced/plugin-author/host-script.ts` and others. ALIVE.
- **`engine/faucet.ts::requestFundsOnce`** — Phase 1 (round1/06 § 5) said dead. It's an
  intentionally-exported helper for test pinning (per its JSDoc). ALIVE; mark `@internal` in JSDoc
  (covered in Wave 1.5).

(Synthesis/05 also surfaced one or two more that need re-confirmation; if the implementer hits a
"this looks dead per Phase 1" item that doesn't appear in §10 or this list, re-grep before
deleting.)

---

## §14 Verification recipe (post-Wave-6)

After Waves 1–6 ship, run the following sequence to verify the package is in a clean state:

```bash
pnpm --filter @mysten-incubation/devstack typecheck

# Fast tests (exclude docker-backed)
pnpm --filter @mysten-incubation/devstack exec vitest run --exclude '**/*.docker.test.ts'

# Docker tests (single sequential pass — they don't compose with concurrent runs)
pnpm --filter @mysten-incubation/devstack exec vitest run '**/*.docker.test.ts'

# Example e2e (spot-check; arena + token-studio are fastest)
pnpm --filter @mysten-incubation/example-arena exec playwright test
pnpm --filter @mysten-incubation/example-token-studio exec playwright test

# Manifest spot-check (after deepbook-full apply)
cat examples/deepbook-full/.devstack/stacks/main/manifest.json | jq .services.postgres.endpoint
# → expect plain URL, no @-password

# /advanced export spot-check
node --experimental-vm-modules -e "import('@mysten-incubation/devstack/advanced').then(m => console.log(Object.keys(m).sort()))"
# → expect CodegenError, DeepbookConfigEmitter, FaucetRequestError in the list

# Snapshot-participation grep
grep -rn 'Snapshot participation:' packages/devstack/src/services/
# → expect 5 hits (sui, walrus, seal, postgres, deepbook)

# annotateDevstackContext callsite
grep -rn 'annotateDevstackContext' packages/devstack/src/
# → expect ≥1 callsite in advanced/tag.ts (Wave 1.1)
```

---

## §15 Coverage check against `.review-findings/`

For my future self: every finding in REVIEW.md and synthesis/\* is covered. Cross-reference:

| REVIEW.md / synthesis ref                       | Wave / § here                                                     |
| ----------------------------------------------- | ----------------------------------------------------------------- |
| Tier A.1 (DeepBook + Postgres)                  | Wave 2                                                            |
| Tier A.2 (annotateDevstackContext)              | Wave 1.1                                                          |
| Tier A.3 (/advanced exports)                    | Wave 1.2                                                          |
| Tier A.4 (override field fate)                  | Wave 3                                                            |
| Tier A.5 (host-gateway + cache.ts)              | Wave 1.3, 1.4                                                     |
| Tier B.1 (Snapshot participation docstrings)    | Wave 4.1                                                          |
| Tier B.2 (typed errors for non-core throws)     | Wave 5.1                                                          |
| Tier B.3 (dev-server PRIMARY/FALLBACK)          | Wave 6.6                                                          |
| Tier B.4 (span PascalCase batch)                | Wave 4.2                                                          |
| Tier B.5 (pythMid → /advanced; TUI types)       | Wave 6.3, 6.4                                                     |
| Tier B.6 (known-package consolidation)          | Wave 5.2                                                          |
| Tier C.1-6 (lazy housekeeping)                  | Wave 7                                                            |
| Part 5 Q1-8 (decisions)                         | §10.1-10.9                                                        |
| Part 5 Q9 (branded types)                       | §10.10 + §12                                                      |
| Part 5 Q10 (snapshot bump)                      | §10.11                                                            |
| Part 5 Q11 (intermediate examples)              | §10.12 + §12                                                      |
| synthesis/01 F-01 (network-resolved factories)  | Wave 3.1                                                          |
| synthesis/01 F-02 (DeepBook dual-write)         | Wave 2.1                                                          |
| synthesis/01 F-03 (Sui network:)                | §10.5 / Wave 3.2                                                  |
| synthesis/01 F-04 (pyth/internal.ts naming)     | Wave 4.3                                                          |
| synthesis/01 F-05 (cache.ts)                    | Wave 1.4                                                          |
| synthesis/01 F-06 (state-store version)         | (covered by AGENTS.md update; no code change needed)              |
| synthesis/01 F-07 (postgres endpoint orphan)    | Wave 2.2 / §10.2                                                  |
| synthesis/01 F-08 (postgres password)           | Wave 2.2                                                          |
| synthesis/01 F-09 (SUI_CHECKPOINT_VOLUME)       | Wave 6.5 / 4.3                                                    |
| synthesis/01 F-10 (composeLayers trichotomy)    | (status quo — no action)                                          |
| synthesis/01 F-11 (bindings fingerprint cache)  | (status quo — speculative; defer per §12)                         |
| synthesis/01 F-12 (dev-server duplication)      | Wave 6.6                                                          |
| synthesis/01 F-13 (snapshot participation docs) | Wave 4.1                                                          |
| synthesis/01 F-14 (wallet auto-from-manifest)   | (status quo — covered by Wave 2 postgres work indirectly; verify) |
| synthesis/02 top-15 — all action-items          | covered above by Tier mapping                                     |
| synthesis/03 — all STAY findings                | §11                                                               |
| synthesis/04 — all themes folded into rationale | §1 Goals + §11                                                    |
| synthesis/05 — all deletion candidates          | Wave 1 + Wave 6                                                   |
| writeup-friction items in synthesis/00          | covered by Waves 1-6 (each friction maps to a wave item)          |
