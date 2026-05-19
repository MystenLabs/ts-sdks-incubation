# Post-launch sweep — closeout + Phase 5 exploration

**Status:** Plan ready for kickoff (2026-05-19). Synthesis of remaining work across all five prior
plans (api-simplification, coin-auto-discovery, deepbook-plugin-expansion, selective-restart,
sui-fork-integration)

- two newly-fired triggers (W12, O22). Verified against shipped code.

Prior plans (post-cleanup 2026-05-19):

- `api-simplification.md` — trimmed (kept §10 ledger, §11 Open Qs, §12 Flips, §15 decisions)
- `coin-auto-discovery.md` — deleted (fully shipped; UI follow-up in Wave 4.6 here)
- `selective-restart.md` — deleted (fully shipped; no remaining work)
- `deepbook-plugin-expansion.md` — trimmed (Phase 0–5 task lists removed; Phase 6 open gates here in
  Wave 4.1)
- `sui-fork-integration.md` — trimmed (Phase −1..4 task lists removed; open gates here in Wave
  4.2–4.5; Phase 5 split to `sui-fork-phase-5.md`)

**Scope:** Waves 1–4 (closeout). Sui-fork Phase 5 exploration is split to
`notes/sui-fork-phase-5.md`.

**§10 decisions settled:** W12 helper = HOF `makeService(name, kind, impl)`; Signer adoption =
structural conformance (`Account extends Signer`); F18 cache GC = manual-only; CI work = skipped for
now.

## §1 Goals

- Close out api-simplification by shipping its 10 decided-but-unshipped items.
- Sweep up the deferred-trigger items now actionable post coin/fork plan completion.
- Fold in W12 (24 `Object.assign` mutation sites) as a centerpiece refactor.
- Consolidate O22 (playwright exports used by 6 example apps).
- Adopt the `@mysten/sui` `Signer` abstract class on `Account` (Q7).
- Finalize deepbook (L3 docker sweep) and sui-fork (P2.T6 example, P-1 test gaps).

Non-goals:

- Re-litigating any §11 Open Question or §12 Flip already DECIDED.
- Implementing the upstream-SDK gRPC parity for `queryTransactionBlocks` (out-of-repo).
- New CI workflows (per §10 decision 4; local-only test runs for now).
- Sui-fork Phase 5 exploration — split to its own plan (`notes/sui-fork-phase-5.md`).

---

## §2 Wave structure & parallel execution recipe

Five waves, gated only where state actually depends on prior work. Items within a wave are
file-disjoint (or further partitioned) so a single `Agent` fan-out can ship the wave.

| Wave | Theme                                                          | Fan-out shape                                             | Gate to next wave                                    |
| ---- | -------------------------------------------------------------- | --------------------------------------------------------- | ---------------------------------------------------- |
| 1    | Deletes + docs + standalone tests                              | N parallel subagents (one per item)                       | None — independent items, merge any order            |
| 2    | W12 centerpiece + signer adoption + service-disjoint refactors | M parallel subagents (one per service for W12 migration)  | Wave 2 helper landed before W12 migration calls      |
| 3    | Engine-shared plumbing + cross-cutting                         | 1–2 subagents (engine shared) + N parallel for non-engine | Wave 2 helpers (some refactors touch the same files) |
| 4    | Integration tests + CI + UI follow-ups                         | Mixed (docker = sequential; UI/CI = parallel)             | Waves 1–3 (so tests cover the final shape)           |
| 5    | Sui-fork Phase 5 exploration                                   | Per-subtopic subagents (mostly file-disjoint)             | None — opt-in; design pass first                     |

Per-wave parallel recipes are at the head of each §.

---

## §3 Wave 1 — Fully parallel deletes, docs, standalone tests

**Recipe:** Single `Agent` message with one subagent per item below. Each is file-disjoint from the
others. Total wall-clock ≈ time of the slowest item.

### 1.1 — Delete wallet `Object.assign` (Flip 6 / item 5.7) — XS — [deferred to Wave 2]

**File:** `packages/devstack/src/services/wallet.ts:37` **Action:** Replace
`Object.assign(walletApp(...), { __kind: 'app', __pluginName: 'wallet' })` with whatever Wave-2
`makeApp` helper resolves to. **Sequencing note:** this lands in Wave 2 if W12 ships first; lands
here only if W12 is deferred. Default: defer to Wave 2 to avoid an interim shape.

**Deferred (2026-05-19):** Folded into Wave 2 §4.1 (W12 makeService helper) per the recon note. No
interim shape; the wallet site migrates alongside the other 23 `Object.assign` sites when the W12
helper lands.

### 1.2 — Delete `ExtraRuntimePaths.addExtra` (Flip 7 / item 5.8) — XS — [x]

**File:** `packages/devstack/src/engine/service-paths.ts:93,110-125` **Action:** Remove `addExtra`
method; make `extras` a constructor-set readonly field. Zero call sites — grep-verified.
**Parallel:** ✅ standalone

**Done (2026-05-19):** Deleted the entire unused `ExtraRuntimePaths` Service (interface,
`ExtraRuntimePathsLive` Layer, `EXTRAS_KEY_RE`); no in-tree or out-of-tree callers existed. Updated
docstring references in `engine/snapshot.ts`, `engine/snapshot.test.ts`, `cli/commands/snapshot.ts`,
and the leading comment in `engine/service-paths.ts` to point at the `saveSnapshot({ extras })`
argument instead of the dead mutator.

### 1.3 — `writeIfChanged` unification (item 5.4 / D3) — S — [x]

**Files:** `packages/devstack/src/engine/atomic-write.ts:46-60` (canonical home),
`packages/devstack/src/codegen/helpers.ts:10-38` (deduplicates). Update callers:
`codegen/emitters/stack-handle.ts`, `dapp-kit-config.ts`, `deepbook-config.ts`, `bindings.ts` to
import from the canonical home. **LOC:** −20 net. **Parallel:** ✅ standalone

**Done (2026-05-19):** Refactored `codegen/helpers.ts:writeIfChanged` to be a thin Effect +
CodegenError wrapper around `writeFileAtomicIfChanged`. The codegen variant keeps its caller-facing
signature (so `stack-handle.ts`, `dapp-kit-config.ts`, `deepbook-config.ts` callsites are unchanged)
but no longer duplicates the read-existing / write-if-different / mkdir-parent logic. Side benefit:
codegen writes are now atomic (sibling-tmp + rename) for free. `bindings.ts` does not use either
helper — its mention in the plan was speculative.

### 1.4 — Snapshot JSDoc backfill (item 5.3 / W10/D16) — S

**Files (6-way fan-out, one subagent per service):**

- `services/sui.ts`
- `services/walrus/local-cluster.ts`
- `services/walrus/nodes.ts`
- `services/seal/internal.ts`
- `services/deepbook/local-deploy.ts`
- `services/sui-indexer-db.ts`

**Action:** Each gets a uniform JSDoc block: "Snapshot participation: this service contributes
`SnapshotMeta.services.<key>`; capture happens at <phase>; restore validates against …". Template in
`AGENTS.md`. **Parallel:** ✅ 6-way fan-out

### 1.5 — Tag substrate ordering + hidden-tag tests (item 5.6 / O39/O40) — S — [x]

**File:** `packages/devstack/src/advanced/tag.test.ts` **Action:** Add two test groups: (a)
hidden-tag behavior (verify non-export tags don't leak through `composeLayers`), (b) ordering tests
(later registrations win, deterministic). **Parallel:** ✅ standalone

**Done (2026-05-19):** Added 7 tests in new file
`packages/devstack/src/advanced/tag-compose.test.ts` covering: (a) hidden tags run the build,
resolve the value, and never surface a TUI entry via the EngineHandle (plus a control case that
non-hidden tags DO surface an entry, plus a failure- propagates-through-hidden test); (b)
`composeLayers` ordering is `inner → primary → projections`, undefined inner entries drop,
`__layers` takes precedence over `__layer`, and the last-wins fold invariant that
`composeStackLayer` depends on. All 7 pass. Pinned in a new file rather than appending to
`tag.test.ts` to avoid the parallel-agent collision risk on Wave 1.

### 1.6 — `dockerContainer` plugin-author example (item 3.4 / O38) — S — [x]

**Path:** `packages/devstack/src/advanced/plugin-author/` already has `docker-container.ts`. Need a
real out-of-tree consumer. **Action:** Add `examples/plugin-author-redis/` or similar — a tiny
example app whose `devstack.config.ts` uses `dockerContainer` to bring up a Redis container, exposes
a tag, demonstrates the routing.protocol and ready-probe APIs. Acts as living documentation.
**Parallel:** ✅ standalone (new example app)

**Done (2026-05-19):** Scaffolded `examples/plugin-author-redis/`. Four files: `redis-plugin.ts`
(the out-of-tree plugin — `defineEntrypoint` + `dockerContainer` with `{pull: 'redis:7-alpine'}`,
TCP ready probe, traefik routing with explicit `protocol: 'http'`, endpoint publish),
`devstack.config.ts` (one-call composition: `devstack(Redis())`), `package.json` (minimal — only
depends on `@mysten-incubation/devstack`), `tsconfig.json`, and a `README.md` explaining the
pattern. Intentionally minimal — no Vite, Move, React, or e2e tests. Typecheck passes. Acts as
living documentation for the `dockerContainer` API surface.

### 1.7 — Walrus TODO triage (in-code) — XS — [x]

**File:** `packages/devstack/src/services/walrus/internal.ts:660-720` **Action:** Either delete the
TODO (wrapper-image deploy path is still monolithic; no signal it will split) **or** convert it to a
single-line note linked to the (non-existent) wrapper-image refactor plan. **Recommendation:**
delete; re-introduce if the refactor materializes. **Parallel:** ✅ standalone

**Done (2026-05-19):** Deleted the TODO inside `registerCommittee` (was at
`services/walrus/internal.ts:688`). The surrounding "this phase is a typed no-op" comment already
explains why the body is empty, so the TODO was redundant. The deferred-list row "Walrus internal
TODO — Wrapper-image deploy path split" stays in §9 as the canonical follow-up trigger.

### 1.8 — Surface verification: §11/§12 closure entries — XS — [x]

**File:** `packages/devstack/notes/api-simplification.md` (final pass) **Action:** Mark Q1–Q6, Q8,
Q9, Q10, Flips 1–5 as `SHIPPED (verified 2026-05-19)`. Q7 → links to §4.2 (Signer adoption). Flips
6, 7 → links to §3.1, §3.2. **Parallel:** ✅ standalone (doc only)

**Done (2026-05-19):** Marked all §11 open questions and §12 flips in
`packages/devstack/notes/api-simplification.md`. Q1–Q6, Q8–Q10 now read
`SHIPPED (verified 2026-05-19)` with code anchors where the api-simplification §8 already had them.
Q7 reads `SCHEDULED — post-launch-sweep.md Wave 2 §4.2`. Flips 1, 3, 4, 5 marked `SHIPPED`; Flip 6
marked `SCHEDULED in post-launch-sweep.md Wave 2 (§4.1 W12)`; Flip 7 marked `SHIPPED` (delivered by
this wave's §1.2).

**Wave 1 total:** 8 items, ≈8 file-disjoint subagents, ~50 LOC net deletes, 6 docstring additions, 1
new example app, 2 test additions, ~2 hours wall.

---

## §4 Wave 2 — W12 centerpiece, signer adoption, service-disjoint refactors

**Recipe:** Sequential gate first — design the W12 helper (one subagent, review-required). Then fan
out by service for the migration (M parallel subagents). Q7 (Signer) and O29 (Account funding) run
alongside.

### 2.1 — W12: `makeService()` / `makeApp()` / `makePlugin()` helper — M (centerpiece) — [x]

**Done (2026-05-19):** Single HOF `makeService(pluginName, kind, impl)` landed in
`packages/devstack/src/advanced/make-service.ts` (re-exported from `/advanced` barrel for
out-of-tree plugins). Migrated all 24 sites across the 8 target services
(`{dev,wallet,deepbook,sui,postgres,pyth,walrus,seal}.ts`); the deepbook file collapsed 8
`Object.assign` boilerplate sites into single-line calls. 6 new unit tests in `make-service.test.ts`
pin the stamp shape (mutating reference, preserved tag fields, all TagKind discriminators,
equivalence with the literal `Object.assign` form). All 36 service unit tests pass unchanged.

**Trigger:** 24 sites of `Object.assign(..., { __kind, __pluginName })` across `dev.ts`,
`wallet.ts`, `deepbook.ts` (8 sites), `sui.ts`, `postgres.ts`, `pyth.ts`, `walrus.ts`, `seal.ts`.
Massively exceeds the 4-site DEFER trigger.

**Design pass (sequential, one subagent):**

- Read each site to characterize `__kind` values and any additional metadata being merged. Produce a
  kind-table.
- Decide helper shape. Strawman:
  ```ts
  export const makeService = <K extends ServiceKind>(
    name: string,
    kind: K,
    impl: LayeredTagBuilder<...>,
  ) => Object.assign(impl, { __kind: kind, __pluginName: name } as const);
  ```
  vs higher-order tag-class wrapping. Open: should this live in `advanced/tag.ts` or a new
  `advanced/make-service.ts`?
- Decide migration sequencing: one PR per service, or one mega-PR?

**Migration (parallel, one subagent per service file):**

- `services/dev.ts`
- `services/wallet.ts` (replaces Flip 6 / item 5.7)
- `services/deepbook.ts` (8 sites — single-file scope)
- `services/sui.ts`
- `services/postgres.ts`
- `services/pyth.ts`
- `services/walrus.ts`
- `services/seal.ts`

**LOC:** −24 sites × ~3 LOC each + 1 helper ≈ −60 net.

**Test gate:** Each service's existing tests must pass unchanged. New helper gets its own unit test
ensuring `__kind`/`__pluginName` propagate identically for value identity (referential equality
preserved if any consumer relies on it; verify nothing does).

**Parallel:** Sequential design pass, then 8-way fan-out migration.

### 2.2 — Q7: Adopt `@mysten/sui` `Signer` interface on `Account` — M — [x]

**Done (2026-05-19):** Re-exported `type DevstackSigner = Signer` from
`packages/devstack/src/advanced/index.ts` (alongside the existing `'signer'`-kind branch of
`AccountSpec` which already accepted a raw `@mysten/sui/cryptography` `Signer` per
`account.ts:216`). Added Signer-conformance JSDoc on `Account` in `engine/shared.ts` making the
structural mapping explicit (`sign{Transaction,PersonalMessage}` mirror Signer's surface; `scheme` ↔
`getKeyScheme()`, `publicKey` ↔ `getPublicKey().toRawBytes()`, `address` ↔ `toSuiAddress()`). No
literal `interface Account extends Signer` — Account's signing closures return
`Effect<..., SignAndExecuteError>` rather than the SDK's `Promise<...>`, which makes class extension
structurally impossible. Audited all 14 `signer:` parameter sites across the codebase: every one
already types as `LayeredTag<any, Account, any, any>` — no ad-hoc signer shapes left to sweep.

**Source:** `@mysten/sui/cryptography` `abstract class Signer` with required abstracts:
`sign(bytes)`, `getKeyScheme()`, `getPublicKey()`. Derived: `signTransaction`,
`signPersonalMessage`, `signAndExecuteTransaction`, `toSuiAddress`.

**Files:**

- `packages/devstack/src/services/account.ts` (interface adoption)
- `packages/devstack/src/engine/shared.ts` (Account internal shape)
- Any signer-receiving service site (need to enumerate)

**Action:** Decide whether `Account` _extends_ `Signer` (class-based) or _conforms to_ `Signer`
(structural duck-typing). Given Effect-first codebase, structural conformance is likely cleaner. Add
a `type DevstackSigner = Signer` re-export under `/advanced` so plugin authors have one canonical
import. Sweep all `signer:` parameter sites to type as `Signer` rather than ad-hoc shapes.

**Test:** Account roundtrips a real signature via the SDK's Signer interface; impersonation path
(fork mode) implements the same surface with a synthetic-signature shape.

**LOC:** ~+30 type adoption, −10 ad-hoc signer shapes ≈ +20 net. **Parallel:** Discovery sequential;
migration ✅ standalone post-design.

### 2.3 — O29: `Account({ funding })` accepts `Coin | LayeredTag` — S — [x]

**Done (2026-05-19):** Widened `AccountFunding` in `services/account.ts` to a union:
`Record<string, bigint> | ReadonlyArray<AccountFundingEntry>` where
`AccountFundingEntry = { coin: { fullCoinType } | LayeredTag<...>, amount: bigint }`. The account
body's funding loop normalizes both shapes through a new `resolveFundingCoinType(coin)` helper that
uses `Context.isKey` to discriminate the LayeredTag form (yielded via `useSync` to read
`fullCoinType` from the bound value) from the bare-Coin form (synchronous field read). 2 new tests
in `account.test.ts` pin both branches; the existing Record-form test stays unchanged. All 13
account unit tests pass.

**File:** `packages/devstack/src/services/account.ts:263-273` **Current:**
`AccountFunding = Record<string, bigint>` — string keys only. **Action:** Widen to
`Record<string, bigint> | ReadonlyArray<{coin: Coin | LayeredTag, amount: bigint}>` or similar;
resolve `Coin`/`LayeredTag` refs to coin-type strings inside. **Coordinate:** with W15 (faucet
lifecycle pin) — funding pull-through uses the auto-mounted faucet. **LOC:** ~+15. **Parallel:** ✅
standalone

### 2.4 — `dockerContainer` example consumes Wave-1 example — XS — [x]

**Done (2026-05-19):** Updated `examples/plugin-author-redis/redis-plugin.ts` to stamp plugin
attribution via `makeService('redis', 'service', container)` after `dockerContainer(...)`. The
dockerContainer primitive already sets `kind: 'service'` internally; `makeService` adds the
`__pluginName: 'redis'` field so the TUI's `[redis]` chip + stable section color light up. The
example typechecks (`pnpm typecheck` clean) and demonstrates the canonical out-of-tree pattern:
import `makeService` from `@mysten-incubation/devstack/advanced`, build the inner tag with the
plugin-author primitives (`dockerContainer` / `dockerImage` / `tag`), then wrap with
`makeService(plugin, kind, impl)` rather than hand-rolling
`Object.assign(impl, { __kind, __pluginName })`.

**Trigger:** Wave 1 §3.6 lands the example app. Wave 2 verifies the example app uses the post-W12
`makeService` shape (i.e., new plugin-author example demonstrates the new helper, not the old
`Object.assign`). **Parallel:** ✅ post-W12

**Wave 2 total:** 4 items, ~8 parallel subagents during migration, ~−40 LOC net, ~3–4 hours wall
(sequential design + parallel migration).

---

## §5 Wave 3 — Engine-shared plumbing + cross-cutting

**Recipe:** Items 3.1, 3.2, 3.3 share `engine/docker.ts`-area surface; keep them in one subagent or
sequence them. Everything else fans out.

### 3.1 — Network-conditional facade dispatch (item 3.5 / D4) — M

**Engine internal.** Today, each network-aware service writes its own
`network === 'mainnet' ? known : local-cluster` branching. Extract to a single facade helper.
**Files:** `engine/network-facade.ts` (new), call sites in `services/sui.ts`, `services/walrus*.ts`,
`services/seal*.ts`, `services/deepbook*.ts`. **Parallel:** ⚠️ engine-shared

### 3.2 — `wrapDocker(toError, phase, msg?)` combinator (item 3.6 / D8) — S — [x]

**Engine internal.** Today, ~12 sites re-wrap Docker errors with phase-specific TaggedErrors. One
combinator + signature. **Files:** `engine/docker.ts` (new helper), sweep `services/*/internal.ts`.
**Parallel:** ⚠️ engine-shared

**Done (2026-05-19):** Landed `wrapDocker(makeError)` in
`packages/devstack/src/engine/docker/wrap.ts`, re-exported from `engine/docker/index.ts` so
`import * as Docker from '../engine/docker.js'` consumers see `Docker.wrapDocker`. Shape: the helper
takes a factory `(cause: DockerError) => E` and returns a pipe-compatible combinator that does
`Effect.catchTag('DockerError', cause => Effect.fail(makeError(cause)))`. The factory shape keeps
the call site in control of which TaggedError class to construct

- which dynamic fields (e.g. `component`, `marginAsset`, interpolated index) to fill — the helper
  only collapses the catchTag plumbing. 4 unit tests in `wrap.test.ts` pin the contract (success
  passthrough, failure swap, `cause` threading, open-coded equivalence). The 25-site call-site sweep
  across `services/*/internal.ts` is deferred to a follow-up agent that owns those files; this
  agent's scope was engine-layer only.

### 3.3 — `contentHash(input, {length})` unification (item 3.7 / D10) — S — [x]

**Engine internal.** Today, image-tag derivation and codegen fingerprinting use different
content-hash shapes. Unify. **Files:** `engine/content-hash.ts` (new), call sites in
`engine/image-build.ts`, `codegen/emitters/bindings.ts`. **Parallel:** ⚠️ engine-shared

**Done (2026-05-19):** Landed `contentHash(input, {length})` + `createContentHasher()`/`digestHex()`
streaming helpers in `packages/devstack/src/engine/content-hash.ts`. One-shot API accepts
`string | Uint8Array | object` (objects flow through `JSON.stringify`; caller canonicalizes sort
order). Streaming API wraps `crypto.createHash('sha256')` so tree-walks and multi- update
fingerprints share the same algorithm + truncation knob. 11 unit tests in `content-hash.test.ts` pin
the contract incl. open-coded equivalence
(`createHash('sha256').update(...).digest('hex').slice(0, 16)` ≡ `contentHash(x, {length: 16})`).

Migrated 11 sites across these files (all using the same sha256 + slice convention; digests match
the previous open-coded form bit-for-bit so no cache-key drift):

- `engine/sui-fork/meta.ts` (configHash, len 16) — pre-stringified to preserve canonical order
- `engine/sui-fork.testkit.ts` (forkImageTag, len 12)
- `engine/supervisor.ts` (watcher file hash, full)
- `services/pyth/local-deploy.ts` (hashFeedSpecs, len 16)
- `services/deepbook/margin.ts` (hashMarginConfig, len 16)
- `services/deepbook/margin-seed.ts` (hashSeedAmounts, len 16)
- `services/walrus/image.ts` (wrapper image input hash, len 12)
- `services/package/internal.ts` (`hashMoveSources`, streaming, len 16)
- `advanced/plugin-author/docker-image.ts` (treeHash streaming, len 12 + configHash len 12)
- `advanced/plugin-author/docker-one-shot.ts` (cacheKey full; uses pre-stringify path because of the
  bigint-safe `jsonReplacer`)
- `codegen/emitters/bindings.ts` (computeFingerprint streaming, len 24)

Sites NOT migrated (deferred for follow-up; ownership constraints on this agent):

- `services/walrus/internal.ts:121` — `subnetForStack` returns a raw `Buffer` digest (not hex), uses
  the streaming surface differently; helper would need a `digestBytes` variant.
- `advanced/plugin-author/git-fetch.ts:155` — sha256 of `${repo}@${ref}`, slice 12. Forbidden file
  for this agent. Trivial migration (`contentHash(...)`); 1-line follow-up.

### 3.4 — Wallet protocol contract integration test (item 5.5) — M — [x]

**File:** `services/wallet/protocol.integration.test.ts` (new) **Action:** Round-trip sample HTTP
request/response shapes through both the devstack server (`@mysten/wallet`-protocol producer) and
the dev-wallet client. Catches drift in either side. **Coordinate:** with W12 §4.1 (wallet.ts is a
W12 site). **Parallel:** ✅ standalone

**Done (2026-05-19):** Landed `services/wallet/protocol.integration.test.ts` — 7 `it.effect` cases
that stand up `walletApp(...)` under `Effect.scoped` (real-keypair–backed Account, stub SuiTag,
isolated `DEVSTACK_ROUTER_DYNAMIC_DIR` tmpdir, OS-assigned ephemeral port) and exercise the full
wire contract: (1) `parseDevstackToken` lifts the `#token=…` fragment off `pairUrl` and matches the
32-hex on-disk shape; (2) `/health` round-trips 200 + `{ok: true}` on an allowed Origin; (3)
`DevstackSignerAdapter.initialize()` hydrates `getAccounts()` via `/accounts` (browser-like Origin
injected on a scoped `globalThis.fetch` shim, restored on scope close); (4) `/sign-transaction`
returns a real Ed25519 signature that verifies under `@mysten/sui/verify`'s
`verifyTransactionSignature` and re-derives the sender address; (5) `/sign-personal-message` ditto
via `verifyPersonalMessageSignature`; (6) signing path without Origin fails-closed at 403 (C12
curl-bypass guard); (7) signing path with a wrong bearer fails at 401 (constant-time compare
reachability). `/accounts` body shape pinned (name/address/scheme/source/publicKey base64). All 7
pass; typecheck clean.

### 3.5 — O22: Playwright export consolidation — M — [x]

**Trigger fired.** 6 example apps use `defineDevstackPlaywrightConfig`, `connectAs`, `test`,
`expect` from `packages/devstack/src/playwright/`.

**Action:**

- Audit duplicated setup across
  `examples/{wallet,arena,token-studio,private-content,deepbook-full,_template}/playwright.config.ts`
  and the e2e specs.
- Document the de-facto public API in `playwright/index.ts` JSDoc.
- Extract any duplicated setup (e.g. `webServer` block, `use:` defaults) into the subpath.
- Verify example apps' configs shrink.

**Parallel:** ✅ standalone (per-example subagents possible)

**Done (2026-05-19):** Audit found all 6 `playwright.config.ts` files already maximally shrunk to
one-call `defineDevstackPlaywrightConfig()` (`private-content` carries the only override —
`timeout: 900_000` for walrus/seal cold-start). Real spec-level duplication lived in
`examples/arena/e2e/connect-four.spec.ts` (hand-rolled `loadManifest()` / `loadKey()` that
re-implemented the on-disk path folklore: `.devstack/stacks/<stack>/manifest.json` +
`runtime/accounts/<name>.key`). Extracted into `packages/devstack/src/playwright/artifacts.ts` as
`loadStackManifest()` (returns the fully-typed v5 `Manifest`) and `loadStackKeypair(name)` (returns
`Ed25519Keypair`). Both piggyback on the shared `discoverManifestPath()` ladder so the env-var /
override / walk-up precedence stays in one place. Rewrote `index.ts` with a JSDoc-documented concern
grouping (config / in-spec helpers / re-exports) so the de-facto public API is now explicit. Arena
spec dropped from 148 to 121 LOC, untyped `RawManifest` gone. All 6 example apps typecheck clean; 24
playwright module tests pass.

### 3.6 — F18: Fork upstream-cache directory refcount/GC — M — [x]

**Trigger fired** (Fork plan Phase 3+ done). **File:**
`packages/devstack/src/engine/sui-fork/meta.ts:13` declares the cache as "shared, refcounted" but no
refcount/GC logic exists.

**Action:** Decide between:

- (a) Refcount: track stack→cache references at stack create/delete; auto-prune when last stack
  drops.
- (b) Age-based eviction: prune entries unused for N days on next `devstack` invocation.
- (c) Manual-only: leave the existing `fork cache prune --unreferenced` and
  `wipe --also-upstream-cache` as the contract; remove "refcounted" claim from docs.

**Recommendation:** (c) for now (manual + explicit); upgrade to (a) if the cache grows beyond pain
threshold. **Parallel:** Design ⚠️ (decision needed first), implementation ✅ standalone.

**Done (2026-05-19) — manual-only per §10.3 decision:** Updated the header comment in
`packages/devstack/src/engine/sui-fork/meta.ts` to drop the "shared, refcounted upstream cache"
claim (was a docs-only forward reference to refcount infra that never landed) and document the
manual-only contract. The replacement note enumerates the existing CLI surface
(`devstack fork cache prune --unreferenced`, `devstack wipe --also-upstream-cache`), the rationale
for refusing refcount/age-based eviction (cycle-time bookkeeping cost vs. an unrealized pain
threshold; caches are ~MB-scale per chainId and re-acquireable without data loss), and the trigger
to revisit (real disk-pressure complaint). Zero code touched elsewhere — no refcount/eviction logic
exists to remove. Per the §10.3 decision, the existing CLI knobs ARE the cache-GC contract; this
item closes as doc-only.

### 3.7 — P7 + W15: Wallet & Faucet lifecycle classification — S — [x]

**Coordinate:** these are the same shape of fix.

- **P7 / wallet server:** `services/wallet.ts` doesn't carry a formal per-cycle vs long-lived
  marker. Audit and pin.
- **W15 / faucet:** `services/faucet/index.ts` similarly unclassified. **Action:** Add `lifecycle`
  field or doc invariant comment per service; update tests to lock the classification. **Parallel:**
  ✅ standalone (different files)

**Done 2026-05-19.** Added `**Lifecycle classification**` header blocks to both `services/wallet.ts`
(ambient: no; singleton; long-lived host process; pairing token is long-lived via state-store,
everything else per-cycle) and `services/faucet/index.ts` (ambient: yes via `fillDefaults`;
in-memory only; per-cycle `Ref<Map>` strategy registry; no snapshot participation). New
`services/faucet/index.test.ts` locks the classification with 5 unit tests: fresh `Ref<Map>` per
layer build, register/list/requestCoin contract + override-shadowing, unknown-coinType failure
shape, `Layer<FaucetTag, never, never>` shape (no state-store / identity deps), and concurrent
disjoint registries. Existing `wallet.test.ts` finalizer/EADDRINUSE test already pins the wallet
per-cycle invariants; no change there. `pnpm --filter @mysten-incubation/devstack typecheck` clean;
15/15 wallet+faucet tests pass.

**Wave 3 total:** 7 items, ~5 parallel subagents (engine items sequenced 1–2), ~+40 LOC net (mostly
tests), ~3–4 hours wall.

---

## §6 Wave 4 — Integration tests + CI + UI polish

**Recipe:** Docker runs are sequential by nature (one stack at a time). UI/CI items run in parallel
alongside.

### 4.1 — Deepbook L3 docker sweep — M (sequential)

**Action:**

- `DEVSTACK_INTEGRATION_TESTS=1 pnpm test` from `packages/devstack/`.
- 8 docker test files to exercise: `market-maker.docker.test.ts`, `pyth/*.docker.test.ts`,
  `deepbook/indexer.docker.test.ts`, etc.
- Fix any regressions. Lock deepbook-plugin-expansion plan as DONE.
- Optional: `pnpm devstack wipe-cache` CLI subcommand for `vendorDeepbook` git-fetch cache (deferred
  from deepbook Phase 5). **Wall:** ~40–50min docker. **Parallel:** ❌ sequential

### 4.2 — Sui-fork docker local sweep — M (sequential)

**Action:**

- Local-only: `RUN_FORK_DOCKER_TESTS=1 pnpm test` from `packages/devstack/`.
- 15+ docker-gated tests across Phases 1–4 to run.
- Fix regressions. Lock sui-fork-integration Phase 1–4 as fully tested.
- **No CI workflow** per §10 decision 4 — manual run only. **Wall:** ~30–45min docker (parallel with
  §6.1 deepbook if Docker resources allow). **Parallel:** ❌ sequential (Docker-bound)

### 4.3 — `examples/fork-greeting/` example app scaffold (P2.T6) — M

**Action:** New example app demonstrating:

- `Sui({ network: 'mainnet-fork', fork: {...} })`
- `Account('alice')` auto-promoted to impersonation
- `from: 'impersonate'` path for an arbitrary mainnet address
- Optional: walrus integration (unblocks P3.T9) **Coordinate:** unblocks `walrus-on-fork` work in
  Wave 5 (P5.1–P5.2). **Parallel:** ✅ standalone

### 4.4 — Sui-fork P-1.T5: Live-net gRPC suite (new tests) — S

**Action:** Write the live-net suite gated on a `RUN_LIVE_NET_TESTS=1` flag — exercises
`SuiGrpcClient` against real testnet/mainnet to catch SDK gRPC parity regressions. **Parallel:** ✅
standalone

### 4.5 — Sui-fork P-1.T3: Playwright × 4 apps re-run — S

**Action:** Run existing playwright e2e suites for arena, wallet, token-studio, private-content with
gRPC-default migration in place. **Parallel:** ✅ 4-way fan-out (one subagent per app — or run all
in CI).

### 4.6 — Coin UI follow-up: dev-wallet → generated `coins.ts` — M — [x] 2026-05-19

**Trigger:** coin plan Phase 5 deferred this to a UI perf follow-up. **Files:**
`packages/dev-wallet/src/ui/dev-wallet-balances.ts`,
`packages/dev-wallet/src/ui/dev-wallet-signing.ts`. **Action:** Replace per-coin RPC waterfalls on
UI load with a single read of the generated `coins.ts` record (emitted by `BindingsEmitter` in coin
Phase 5). **Coordinate:** with W12 §4.1 (dev-wallet may have its own \_\_kind sites). **Parallel:**
✅ standalone (different package)

**Done 2026-05-19:** added a `coins` property (typed as a structural `CoinRecord` subset of the
generated `coins.ts` shape) to `DevWalletBalances`, `DevWalletSigning`, `DevWalletSigningModal`,
`DevWalletPanel`, `DevWalletStandalone`, and the `WalletController`. `mountDevWallet()` accepts a
matching `coins` option. New helpers `indexCoinsByType` / `lookupCoinByType` in `ui/utils.ts` build
a normalized `type → entry` lookup so the balances list and signing-modal coin-flow rows skip the
per-coin `getCoinMetadata` RPC entirely for known types; unknown types still fall through to the
network. Two browser tests in `tests/browser-ui.test.ts` cover both branches. dev-wallet remains
structurally decoupled from the devstack package (consumers pass the generated record explicitly).

**Wave 4 total:** 6 items. Docker sweeps sequential (~1.5 hours wall). UI/CI items parallel (~1 hour
wall).

---

## §7 Wave 5 — split to its own plan

Sui-fork Phase 5 exploration (Walrus shim, Seal audit, auto-tick, parallel stacks, cold-start,
dev-wallet fork UI, subscriptions) is **out of scope for this sweep**. It lives in
`packages/devstack/notes/sui-fork-phase-5.md` with its own design log and decision points.
Cross-reference only.

Rationale: Phase 5 is the most greenfield work in the remaining backlog, each subtopic needs its own
design pass, and folding it into this closeout sweep would bloat the plan as design clarifies.
Closeout (Waves 1–4) closes first; Phase 5 picks up when ready.

---

## §8 Confirmed shipped (closure — no action)

These were on the deferred list but verification confirmed they're already done in shipped code:

**From api-simplification:**

- O11 — `Coin` type collision: dual namespaces prevent collision; no name-mangling needed
- O25 — `metadataId` capture leaf: fully wired through coin/discovery + manifest emission
- O41 — `registerCoin` e2e test: registerCoin deleted; test target gone
- N5 — Faucet tag-key matcher: auto-mount rule implemented via `compose/defaults.ts:29`
- P8 — Default-fill predicate: only Sui+Faucet predicate exists; no table needed
- D12 — Per-coin RPC waterfalls: batched via `fetchCoinMetadataMany()`
- D13 — `registerCoin` triple-duplication: deleted with registerCoin
- O28 — `upgradeCapId` known-package wire-in: present and used in `known-package.ts`
- F11 — gRPC mid-migration doc: AGENTS.md + inline Phase −1 comments cover the narrative
- Cross A6 — `/advanced` barrel re-audit: barrel is cohesive (7 logical groups, 21 exports)
- Cross D2 — `Effect.withSpan` codemod: good coverage already; codemod unneeded

**From §11 Open Questions (all DECIDED 2026-05-18):**

- Q1 ✓ `SnapshotMeta.services` via declaration merging (`engine/snapshot.ts:133`)
- Q2 ✓ `dockerContainer` integrated single-call (`advanced/plugin-author/docker-container.ts:497`)
- Q3 ✓ Wallet singleton, `options.name` dropped
- Q4 ✓ `pickCreatedByType*` collapsed (`engine/sui-helpers.ts:84-91`)
- Q5 ✓ `dockerContainer` parametricity `LayeredTag<Name, Handle>`
- Q6 ✓ `acquireFileLock` consolidation (`engine/file-lock.ts`)
- Q8 ✓ Image source `{pull: string}` only
- Q9 ✓ `waitForBalanceUpdate` deleted
- Q10 ~ Coin coordination: coin plan complete, decision moot

**From §12 Flips:**

- Flip 1 ✓ `defineRegistry<T>()` extracted (`engine/define-registry.ts`)
- Flip 3 ✓ Fork `runtime` derived from network

---

## §9 Kept deferred (with current triggers)

| ID                   | Item                                                  | Trigger                                   | Action when fired             |
| -------------------- | ----------------------------------------------------- | ----------------------------------------- | ----------------------------- |
| O20                  | `withDevstack`/vitest helper                          | Real chain-mode test in `_template`       | Promote or delete             |
| G7                   | `gatherManifest` 5-emitter trigger                    | 5th emitter lands                         | Extract shared call           |
| G4                   | Fingerprint cache asymmetry                           | Bindings caching pattern wanted elsewhere | Generalize                    |
| Walrus internal TODO | Wrapper-image deploy path split                       | Wrapper image refactor begins             | Add per-node moveCall fan-out |
| Arena gRPC migration | Upstream SDK ships `queryTransactionBlocks` over gRPC | Migrate arena example                     |

**Removed from deferred list:** W12 (folded into Wave 2 §4.1), O22 (folded into Wave 3 §5.5), Cross
D2 (already-good coverage), Cross A6 (barrel verified cohesive).

---

## §10 Decisions (settled 2026-05-19)

1. **Wave 2 §4.1 W12 helper shape — DECIDED: HOF.** `makeService(name, kind, impl)` as a
   higher-order function in `advanced/make-service.ts`. Site shape:
   `export const Wallet = (opts?) => makeService('wallet', 'app', walletApp(opts))`.
2. **Wave 2 §4.2 Signer adoption — DECIDED: structural conformance.** `Account` becomes
   `interface Account extends Signer` (importing the SDK's `abstract class Signer` as a type). No
   class extension. Re-export `type DevstackSigner = Signer` from `/advanced` for plugin authors.
3. **Wave 3 §5.6 F18 cache GC — DECIDED: manual-only.** Keep existing
   `fork cache prune --unreferenced` and `wipe --also-upstream-cache` CLI surface. Drop the
   "refcounted" claim from `engine/sui-fork/meta.ts:13` docs. Re-evaluate if cache size becomes a
   real complaint.
4. **Wave 4 CI work — DECIDED: skip for now.** No new CI workflows in this sweep. Local
   `DEVSTACK_INTEGRATION_TESTS=1` and `RUN_FORK_DOCKER_TESTS=1` runs remain manual.
   `§6.2 Sui-fork docker CI job` removed.
5. **Wave 5 scope — DECIDED: split.** Sui-fork Phase 5 exploration moves to
   `packages/devstack/notes/sui-fork-phase-5.md`. This sweep covers Waves 1–4 only.

---

## §11 Parallel-execution matrix

For each wave, the maximum file-disjoint parallel fan-out:

| Wave                    | Item                                   | Subagents            | Sequencing notes                         |
| ----------------------- | -------------------------------------- | -------------------- | ---------------------------------------- |
| 1                       | 1.1 wallet Object.assign delete        | (folded into Wave 2) | —                                        |
| 1                       | 1.2 ExtraRuntimePaths delete           | 1                    | —                                        |
| 1                       | 1.3 writeIfChanged unify               | 1                    | —                                        |
| 1                       | 1.4 Snapshot JSDoc backfill            | 6                    | one per service                          |
| 1                       | 1.5 Hidden-tag/composeLayers tests     | 1                    | —                                        |
| 1                       | 1.6 dockerContainer example            | 1                    | —                                        |
| 1                       | 1.7 Walrus TODO triage                 | 1                    | —                                        |
| 1                       | 1.8 §11/§12 closure entries            | 1                    | —                                        |
| **Wave 1 max parallel** |                                        | **~12**              | merge any order                          |
| 2                       | 2.1 W12 design                         | 1                    | sequential design before migration       |
| 2                       | 2.1 W12 migration                      | 8                    | one per service after helper lands       |
| 2                       | 2.2 Signer adoption                    | 1+N                  | discovery serial; sweep parallel         |
| 2                       | 2.3 Account funding widening           | 1                    | —                                        |
| **Wave 2 max parallel** |                                        | **~10**              | after design pass                        |
| 3                       | 3.1–3.3 engine plumbing                | 1–2                  | engine-shared; sequence 1→2→3            |
| 3                       | 3.4 wallet protocol test               | 1                    | —                                        |
| 3                       | 3.5 O22 playwright consolidation       | 6                    | one per example app                      |
| 3                       | 3.6 F18 cache GC                       | 1                    | after design                             |
| 3                       | 3.7 lifecycle classification           | 2                    | wallet + faucet                          |
| **Wave 3 max parallel** |                                        | **~10**              | engine items sequential within group     |
| 4                       | 4.1 deepbook docker sweep              | 1                    | sequential by nature                     |
| 4                       | 4.2 sui-fork docker local sweep        | 1                    | sequential by nature (Docker-bound)      |
| 4                       | 4.3 fork-greeting example              | 1                    | —                                        |
| 4                       | 4.4 live-net gRPC suite                | 1                    | —                                        |
| 4                       | 4.5 playwright × 4 apps                | 4                    | one per app                              |
| 4                       | 4.6 dev-wallet → coins.ts              | 1                    | —                                        |
| **Wave 4 max parallel** |                                        | **~9**               | docker sweep blocks others by CPU/Docker |
| 5                       | (split to `notes/sui-fork-phase-5.md`) | —                    | —                                        |

---

## §12 Open follow-ups (not in this plan)

- Upstream SDK gRPC parity for `queryTransactionBlocks` (blocks arena example migration to
  gRPC-default).
- Rust-side `sui-fork` cold-start image-build recipe (Wave 5 §5.5 coordination).
- If Wave 5 grows beyond 3 active subtopics: extract to `notes/sui-fork-phase-5.md` with its own
  design log.
