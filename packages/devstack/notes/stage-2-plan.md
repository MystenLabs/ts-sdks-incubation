# Devstack Stage 2 — Plan

This plan covers both **what** we're building and **how** we'll build it. The goal of "how" is a high-quality result, which means design-before-code per subsystem, type-safe public APIs by construction, an example migration as the proof per phase, and zero direct lifts from `packages/devstack-a/`.

`devstack-a` is informative for *use cases* — what must work — but its *shapes* (8 action discriminators, stringly-keyed registry, phantom-marker validation, `defineConfig` mega-helpers) are not the design we're shipping. Every new API in `devstack-b` is a first-principles design that fits B's grain (producer graph + typed Deps + runners + plugin schemas).

---

## 1. Frame

Ship one package called `@mysten-incubation/devstack` (no `-a` / `-b` / `-next` suffix). The package has:

- B's engine and plugin model (producer graph + typed `Dep<T>`).
- The surround that's currently missing in B: vitest/playwright harness, signer leasing, single-instance enforcement, the CLI verbs users actually depend on.
- **No React bindings** (decided codesmell; frontend contract is the generated manifest TS file).
- Publish-ready hygiene (LICENSE, CHANGELOG, `files:`, `prepublishOnly`, smoke test).

End state of this stage: examples in this monorepo depend on `@mysten-incubation/devstack` for *everything* (config, CLI, vitest, playwright). `packages/devstack-a/` is deleted.

---

## 2. Principles (constraints on every API decision below)

1. **Every long-running concern is a producer.** Containers, host processes, dev servers, lockfiles, account pools — anything with state and a lifecycle goes through `define()` / `defineSchema()` and lives in the topo-sorted graph. New subsystems do **not** get a parallel lifecycle bus.
2. **Every shared resource flows through a Dep.** Ports, signers, lease handles, network names, image tags — consumers receive resources via `producer.get('key', args?)`. No magic registry lookups.
3. **Identity drives reruns; nothing else.** A node re-fires when its `inputs()` hash changes. Subsystems that want a rerun mutate state visible through a Dep; they do not call into the engine to "fire X".
4. **User-facing config holds data, not closures over engine internals.** A user reading `devstack.config.ts` top-to-bottom must know what runs when. Callbacks receive a documented `{ env, deps }` shape only.
5. **Producers are typed at the call site; the engine is generic.** Consumer code sees `pool.get('signer', { name })` typed as `Dep<Ed25519Keypair>`. The engine sees `Dep<never>` internally. The seam between them does not weaken further.
6. **One canonical implementation per concern.** No parallel shapes (`standard/account-pool.ts` vs `plugins/accounts.ts` collapse to one).
7. **Frontend contract is the manifest, not a binding.** React, dApp-Kit setup, etc. live in user code or a separate package.
8. **Plugin authors are the public API.** A plugin's type signatures, factory ergonomics, and error messages are surface that other people read and copy. If writing a plugin requires `<any>`, eslint-disables, ceremonial generics, or knowledge of engine internals, the API is wrong — fix the API, not the plugin. Achieved by design, not lint (we don't lint).

---

## 3. Subsystem designs

Each subsystem below lists: the problem, the proposed shape, **what you'd actually write** (the plugin/test-author seat — a copy-pasteable snippet so API friction is visible before code lands), what it deliberately does NOT do, alternatives considered, and how to implement it well. The "how to implement" notes are the quality bar for that subsystem — they are not optional.

### 3.1 Vitest harness

**Problem.** A vitest run wants the stack reconciled once before any spec executes, then wants each spec to read endpoints, package IDs, account names, etc., without paying the bring-up cost per file.

**Shape.**

```ts
// devstack/vitest — composable building blocks, no mega-helper.
// `SetupOptions` are all optional; defaults: appDir = cwd-walk for
// devstack.config.ts, stack = process.env.DEVSTACK_STACK ?? 'main'.
export async function setup(opts?: SetupOptions): Promise<SetupHandle>;
export async function teardown(handle: SetupHandle): Promise<void>;

// `Manifest<TExtras>` is the standard shape with a generic `extras`
// slot so apps that emit typed extras get them back typed; default
// `Record<string, unknown>` for the unannotated case.
export async function readManifest<TExtras = Record<string, unknown>>(
  opts?: ReadOptions,
): Promise<Manifest<TExtras>>;
export async function readSnapshot(opts?: ReadOptions): Promise<SnapshotRecord | undefined>;

// Typed fixture authors compose into their own `test`:
//   const test = baseTest.extend<DevstackFixtures>(devstackFixtures());
export function devstackFixtures(opts?: FixtureOptions): {
  manifest: Fixture<Manifest>;
  rpcUrl: Fixture<string>;
  faucet: Fixture<{ fund: (addr: string) => Promise<void> }>;
};
```

**What you'd write.**

```ts
// devstack-setup.ts (vitest globalSetup target)
import { setup, teardown } from '@mysten-incubation/devstack/vitest';
export default async function () {
  const handle = await setup();          // auto-detects appDir + stack
  return () => teardown(handle);
}

// some.test.ts
import { test as baseTest } from 'vitest';
import { devstackFixtures } from '@mysten-incubation/devstack/vitest';
const test = baseTest.extend(devstackFixtures());
test('publisher mints to alice', async ({ manifest, faucet }) => {
  const alice = manifest.accounts.find((a) => a.name === 'alice')!;
  await faucet.fund(alice.address);
  // assertions...
});
```

**Composition.** No new producer or runner. The fixture reads the same JSON sidecar that `manifest()` already writes.

**Does NOT.** No `defineDevstackVitestConfig`. No `inject('devstack')` magic. No enforced `pool: 'forks'` — that's a vitest-config choice the user makes.

**How to implement well.**

1. **Use-case inventory first** — read `packages/devstack-a/src/vitest/{globalSetup,accountPool}.ts` and the example apps' `vitest.config.ts` to enumerate every scenario the harness must cover. Write the list down in the PR description. Do not open code files until that list is locked.
2. **Tests before implementation** — write the typing tests (`expectTypeOf(fixture.manifest).toBe<Manifest>()`) and the behavior tests against the API sketch above. Implementation lands second.
3. **One example migration in the same PR** — `examples/_template/vitest.config.ts` flips from `devstack-a/vitest` to the new module; tests pass.
4. **Snapshot the public surface** — `vitest/index.ts` exports get a snapshot test so accidental additions get flagged in review.

**Alternatives dismissed.**
- Port A's `defineDevstackVitestConfig + chain: true` — hides too much behind a config helper users can't debug.
- In-process shared engine via `inject()` — handles don't survive worker forks; A had to work around this with disk anyway.
- Vitest plugin (`vitest-plugin-devstack`) — vitest plugin surface is unstable.
- Sidecar `devstack up --stack test` before `vitest run` — doubles bring-up cost, requires shell coordination.

---

### 3.2 Playwright harness

**Problem.** Playwright tests want (a) the dev server's URL handed to `webServer:`, (b) per-worker stack isolation, (c) the same manifest accessor vitest gets.

**Shape.**

```ts
// devstack/playwright — three pieces, composed by the user.

// 1. A pre-extended `test` with worker-scoped manifest + rpcUrl.
//    Stack name is `e2e-${workerIndex}` so workers don't collide.
//    No `engine` fixture — Playwright specs have no business poking
//    at engine internals; if you need that, drop down to the vitest
//    side or write a CLI smoke test.
export const test: TestType</* devstackFixtures */ {
  manifest: Manifest;
  rpcUrl: string;
}, /* worker-scoped */ {
  stack: string;
}>;
export { expect } from '@playwright/test';

// 2. webServer wire-up derived from the same manifest. Fails loudly
//    if the named endpoint isn't in the manifest — no silent localhost
//    fallback.
export function webServer(opts: {
  endpoint: string;             // e.g. 'vite-dev'
  manifestPath?: string;        // default: discovery
}): PlaywrightConfig['webServer'];

// 3. Per-worker bring-up if the user wants playwright to own lifecycle.
//    Same names as the vitest harness so authors don't context-switch.
export async function setup(opts?: SetupOptions): Promise<SetupHandle>;
export async function teardown(handle: SetupHandle): Promise<void>;
```

**What you'd write.**

```ts
// playwright.config.ts
import { defineConfig } from '@playwright/test';
import { webServer } from '@mysten-incubation/devstack/playwright';
export default defineConfig({
  globalSetup: require.resolve('./devstack-setup.ts'),
  webServer: webServer({ endpoint: 'vite-dev' }),
});

// some.spec.ts
import { test, expect } from '@mysten-incubation/devstack/playwright';
test('user can mint USDC', async ({ page, manifest, rpcUrl }) => {
  const viteDev = manifest.endpoints.find((e) => e.name === 'vite-dev')!.url;
  await page.goto(viteDev);
  // assertions against the live RPC at rpcUrl...
});
```

**Composition.** Reuses the vitest `setup` / `teardown` and `readManifest` primitives. No new producer / runner / CLI verb.

**Does NOT.** No `defineDevstackPlaywrightConfig`. No bundled `connectAs` (see 3.4). No baseline `account` fixture (see 3.3 — composes in optionally). No `engine: WorkerFixture<Engine>` — exposes engine internals to test code without a real use case.

**How to implement well.**

1. **Migrate `examples/wallet/playwright.config.ts` in the same PR** — this example has the densest e2e coverage and surfaces gaps.
2. **Per-worker stack name must be deterministic and observable** — workers print their stack name on first fixture use; this is critical for debugging hung tests.
3. **`webServer({ endpoint })` must fail loudly** when the named endpoint doesn't exist in the manifest — never silently fall back to `localhost:5173`.

**Alternatives dismissed.**
- A's `defineConfig` mega-helper — too much hidden coupling between fixture and config.
- One stack for the whole suite — defeats parallel workers.
- Spawn `devstack up --stack e2e-N` as a child per worker — process-per-worker overhead and lockfile contention.

---

### 3.3 Signer leasing

**Problem.** Parallel tests need exclusive access to seeded keypairs. Two specs using the same signer concurrently collide on gas coin versions and lose data.

**Position.** This is **runtime-only**, not a producer. The lease ledger lives only inside one test runner's process; persisting through the engine snapshot buys nothing.

**Shape.**

```ts
// devstack/leasing — runtime-only. The pool is exposed as a worker
// fixture so test authors don't construct it; the explicit factory
// stays available for non-vitest/non-playwright callers.

export interface Lease {
  name: string;
  signer: Signer;
  release(): void;                    // idempotent; throws if double-released
}

export class SignerPool {
  acquire(opts?: { preferred?: string[] }): Promise<Lease>;
  withLease<T>(fn: (lease: Lease) => Promise<T>): Promise<T>;
  leakedLeases(): Lease[];             // diagnostics

  // Construct from a Manifest's `accounts:` slot — the standard path
  // for both vitest and playwright fixtures, and the explicit path
  // for hand-rolled callers.
  static fromManifest(
    manifest: Manifest,
    opts?: { acquireTimeoutMs?: number; onLeak?: (name: string) => void },
  ): SignerPool;
}

// `signerPool` is added to both vitest and playwright `devstackFixtures()`
// by default; test authors get it for free.
```

**What you'd write.**

```ts
// some.test.ts (vitest) — `signerPool` is in the default fixture set
import { test as baseTest } from 'vitest';
import { devstackFixtures } from '@mysten-incubation/devstack/vitest';
const test = baseTest.extend(devstackFixtures());

test('two concurrent publishes against alice serialize', async ({ signerPool }) => {
  await signerPool.withLease(async ({ signer }) => {
    // publish #1 — alice is held exclusively for the duration
  });
});

// Explicit construction (rare):
import { SignerPool } from '@mysten-incubation/devstack/leasing';
const pool = SignerPool.fromManifest(manifest);
```

**Composition.** No new producer. The pool consumes the manifest's `accounts:` list to materialize per-name Signers.

**Does NOT.** No cross-process / cross-worker coordination (worker-per-stack disambiguates). No persistence between runs. No bare `new SignerPool({ signers: {...} })` constructor — that's friction we don't need; `fromManifest` is the one entry point.

**How to implement well.**

1. **Property-test the queue** — fast-check 100 random acquire/release sequences against the invariant "no two concurrent leases for the same name". Cheap insurance against a class of bugs.
2. **Default `onLeak` to `console.error` with a stack trace** captured at acquire time. Leaked leases must be debuggable from the test log.
3. **`withLease` is the recommended path** — `acquire`/`release` is the escape hatch. Document accordingly.

**Alternatives dismissed.**
- Pool-as-producer — leases are per-process, not per-stack.
- File-based ledger — filesystem locking is fragile; data is ephemeral.
- Postgres/Redis — adds infra for a problem solved by in-memory queue + worker-per-stack.

---

### 3.4 UI gesture helpers (`connectAs`, etc.)

**Position. Owned by devstack for now.** `connectAs`, `selectAccount`, `waitForBalanceUpdate` are shipped from `@mysten-incubation/devstack/playwright`. The original sketch had them living in `@mysten-incubation/dev-wallet/playwright` (since they're dev-wallet implementation knowledge — DOM selectors, modal flow, `globalThis.__devstackDAppKit__`), but until the dev-wallet team has a `/playwright` subpath and bandwidth to maintain it, the helpers stay here. Co-locating them with `test` / `expect` / `webServer` also keeps the example apps' imports to a single `@mysten-incubation/devstack/playwright` line.

**Shape.** `connectAs(page, label)`, `selectAccount(select, name)`, `waitForBalanceUpdate(page, name, predicate, opts?)`. Same signatures the example apps already use.

**How to implement well.**

1. **The contract between devstack and the wallet helpers is the manifest's `wallet-app` endpoint name + the `globalThis.__devstackDAppKit__` slot** — keep both stable across versions. `createDevstackDappKit` from `/dapp-kit` sets the global automatically under Vite dev / preview / `PLAYWRIGHT=1`.
2. **If/when the dev-wallet team adopts these,** the migration is a re-export from `/dev-wallet/playwright` with eventual deletion from devstack — but that's a future decision, not Phase 4 scope.

---

### 3.5 Same-signer mutex (concurrency)

**Problem.** Two `publishMove`s with the same publisher cannot run in parallel — they'll fight over the gas coin. B's engine is strictly serial today, which avoids the bug by accident but at the cost of every cycle being slower than it could be.

**Position.** Reintroduce parallelism via a *typed* resource-claim mechanism on Deps — not a side channel.

**Shape.**

```ts
// New factory next to `dep`.
export interface ExclusiveDepRecipe<TState, TData, TConsumerView>
  extends DepRecipe<TState, TData, TConsumerView> {
  __exclusive: true;
  lockKey(state: TState, data: TData): string;
}

export function exclusiveDep<TState, TData, TView>(recipe: {
  get: (s: TState, d: TData) => TView;
  lockKey: (s: TState, d: TData) => string;
}): ExclusiveDepRecipe<TState, TData, TView>;

// accounts plugin gets an `exclusive` projection on `signer`:
//   pool.get('signer', { name: 'publisher' })       // shared (today)
//   pool.get('exclusive', { name: 'publisher' })   // exclusive
//   // lockKey = `signer:${name}`
```

**Engine change.** Sort `topoOrder` into ranks; within each rank, build a conflict graph by lock-key, color it, execute colors sequentially with each color in parallel. Worst case (every node shares a key) collapses to today's serial behavior.

**What you'd write.**

```ts
// Plugin-author seat (accounts plugin) — declare the projection
// alongside `signer`. The recipe's TState / TData infer from the
// callback parameters; the author writes no explicit generics.
const accountsProvides = {
  signer: dep((s: AccountsState, d: { name: string }) => s.signers[d.name]),
  exclusive: exclusiveDep({
    get: (s: AccountsState, d: { name: string }) => s.signers[d.name],
    lockKey: (_s, d) => `signer:${d.name}`,
  }),
} satisfies Provides<AccountsState>;

// Consumer seat (downstream plugin) — pick the projection that fits.
// Same Dep<Keypair> type either way; the engine handles the mutex.
const tx = runTransaction({
  signer: accounts.pool.get('exclusive', { name: 'publisher' }),
  // ...
});
```

**Does NOT.** Cross-cycle locks. A lock is per-cycle; if a node errors out holding it, the cycle ends and the next cycle re-acquires.

**How to implement well.**

1. **Drop `runsAs` from `NodeImpl` in the same change** — it's dead config today and the new mechanism replaces its intent.
2. **Write the conflict-graph coloring as a pure function** (`engine/scheduling.ts`) with unit tests independent of the engine cycle. This is the single hardest piece of correctness in the plan; keep it small and exhaustively tested.
3. **Benchmark before/after** with the largest example (`examples/wallet`): cold-start cycle time must improve or the change isn't worth it. Record numbers in the PR.
4. **Stress test**: 4 concurrent `runTransaction`s with overlapping signers — verify nothing fails with "object version is not the latest" over 100 runs.

**Alternatives dismissed.**
- String-keyed `runsAs` mutex — stringly-typed, doesn't compose, every consumer must know the magic string.
- Per-producer self-queueing — pushes the concern into every plugin; bug-prone.
- `concurrency: 'serial' | 'parallel'` knob — too coarse; doesn't capture cross-node mutual exclusion.
- `worker_threads` — gross overkill; bottleneck is awaiting external I/O.

---

### 3.6 Cascade behavior (settling)

**Position. Two-cycle settling is fine in steady state.** A's bounded "emit cascade" round was a response to its 8-discriminator problem; B's uniform producer pass already handles non-Emit ordering. The cost is one extra cycle on cold-cold starts (publish → bindings → manifest). Mitigate, don't redesign.

**Shape.**

```ts
// engine/class.ts — extend Engine.
export class Engine {
  runOnce(): Promise<CycleResult>;          // existing
  settle(opts?: { maxCycles?: number }): Promise<CycleResult[]>;
}
```

`apply` and `up` call `settle({ maxCycles: 4 })`. The `maxCycles` guard prevents infinite loops from a buggy producer that endlessly `requestRerun`s itself.

**What you'd write.** Engine-internal; plugin authors don't call this. CLI verbs and the test harness do:

```ts
// vitest + playwright setup() internals
const engine = new Engine(config, { env });
await engine.settle();  // runs cycles until stable or maxCycles
```

**How to implement well.**

1. **`settle` ships as stable public API from 0.1.0** — no `@experimental` tag. Cascade semantics are part of the semver contract going forward; we change them only with intent.
2. **Log the cycle count** on apply/up completion — if production cold starts regularly hit `maxCycles`, that's a signal we need a better design.
3. **Unit-test the loop termination** with a producer that flaps (`requestRerun` on every cycle) — must error cleanly at `maxCycles`, not hang.

---

### 3.7 Single-instance enforcement

**Problem.** Two `devstack up` invocations on the same stack silently fight over docker labels, snapshot writes, port allocator state.

**Position.** Persistence concern with a CLI entry point — not a runner, not a producer. Identified by realpath-of-`<appDir>/.devstack/stacks/<stack>/`, not just stack name (so two `appName=foo, stack=main` from different repos don't conflict).

**Shape.**

```ts
// devstack/persistence/lock.ts
export class StackLockBusyError extends Error {
  holderPid: number;
  holderStartedAt?: number;
  path: string;
}

export interface StackLockHandle { path: string; release(): Promise<void> }

// Primary form — auto-detects env from cwd + DEVSTACK_STACK.
export async function withStackLock<T>(fn: () => Promise<T>): Promise<T>;
// Explicit form — for cross-stack tools that need to lock a stack
// other than the caller's own.
export async function withStackLock<T>(env: Env, fn: () => Promise<T>): Promise<T>;

// Lower-level — same auto-detect / explicit pair.
export async function acquireStackLock(env?: Env): Promise<StackLockHandle>;
export async function inspectStackLock(env?: Env): Promise<{ pid: number; alive: boolean } | null>;
```

Path: `<stackDir>/supervisor.pid` (localnet) or `<networkDir>/.lock` (live). PID-reuse defense: read start time via `ps -o lstart=` (macOS / Linux). Unparseable lock files: treat as stale and replace.

**What you'd write.**

```ts
// CLI verb internals — auto-detect is what 95% of callers want.
import { withStackLock } from '@mysten-incubation/devstack/persistence';
await withStackLock(async () => {
  // mutate the stack (apply / up / snapshot / wipe)
});

// Cross-stack tooling — explicit env when locking somewhere other
// than the cwd's own stack.
await withStackLock(targetEnv, async () => { /* ... */ });
```

**Wired into.** `up`, `apply`, `snapshot save/restore/delete`, `wipe`, `stack use/down`, vitest/playwright bring-up.

**Does NOT.** Lock non-mutating reads (`status`, `stack list`, `snapshot list`). Lock at the engine level — keeps in-process re-use (vitest harness calling `engine.runOnce` repeatedly) unaffected. No required `Env` argument — auto-detect from cwd + `DEVSTACK_STACK` is the primary path.

**Lock granularity.** One exclusive lock per stack realpath. No shared/exclusive split, no recursion. Test harnesses are structured so contention doesn't arise:

- **Vitest** acquires once in `globalSetup` (parent process). Workers don't lock — they only `readManifest()`, which is by design non-mutating. A worker that genuinely needs to mutate engine state will block on the parent's lock, which is the right behavior (mutations should serialize).
- **Playwright** workers each have their own per-worker stack (`e2e-${index}`), so they hold distinct locks; no inter-worker contention possible.

**How to implement well.**

1. **`StackLockBusyError` must include actionable text**: holder PID, holder start time, the path to remove if stale. A frustrated user reading the error should know exactly what to do.
2. **Test the stale-PID-reuse path explicitly** — write a test that writes a lock file with PID 1 (init, always alive) and one with a random high PID that's almost certainly dead; verify the second is detected as stale and replaced.
3. **No silent retries.** If acquire fails, error immediately. The user decides whether to wait.

---

### 3.8 CLI verbs (final table)

| Verb | Status | Notes |
|---|---|---|
| `up` | keep | Add `--once` (run one cycle, exit). `--no-watch` already exists. |
| `apply` | keep | Add `--target <network[:stack]>` shorthand. Drop A's `--actions <subset>` (no action discriminators to filter on). |
| `status` | keep | Read-only snapshot dump. |
| `snapshot save / restore / list / delete` | keep | Drop `--dry-run`, `--push`, `snapshot id` (low-value or covered by `--json`). |
| `wipe` (was `reset` in B) | rename | Stop + remove on-disk state. Require `--yes`. Add `--images` flag for `docker image prune`. `reset` aliases for one release, then drops. |
| `stack list / new / use / down / drop` | keep | `drop` is `wipe --stack <name>`. |
| `doctor` | keep | Existing. |
| `codegen` | drop | Engine cycle already emits bindings; `apply` is idempotent. |
| `console` | defer | Useful but standalone; land post-v1. |

**How to implement well.**

1. **Each verb's CLI module exports a programmatic `runX(opts): Promise<XResult>`** — already B's pattern. Keep it; it's why B's CLI is testable.
2. **`cli.test.ts` must exercise every flag combination** — B's existing 979-line CLI test is the template, extend it.
3. **`--json` output schema** documented in a TypeScript interface per verb, exported. Scripts depend on this.
4. **Wrap every mutating verb in `withStackLock`** — single shared helper, not copy-pasted try/finally.

---

### 3.9 Naming, hygiene, publish readiness

> **Status: Phase 1 shipped.** The rename + type-leak work is done. This section records what actually landed (which diverged from the original sketch in two places — noted inline). Publish readiness still moves in Phase 6.

**Rename — landed.**

1. `git mv packages/devstack-b packages/devstack`. ✓
2. `package.json`: `"name": "@mysten-incubation/devstack"`, `"version": "0.1.0"`, `"bin": { "devstack": "./dist/cli/main.mjs" }`, `"repository.directory": "packages/devstack"`. `"private": true` **kept** for Phase 1 — Phase 6 owns publish-readiness, and removing `private` without the `prepublishOnly` chain is half-done.
3. Swept `devstack-next` (62 occurrences) and `devstack-b` (38 occurrences in real source; lockfile excluded as it regenerates).
4. `DEVSTACK_NEXT_VERSION` → `DEVSTACK_VERSION`. ✓
5. Test fixture tmpdirs swept. ✓
6. Manifest's rendered import specifier: `'@mysten-incubation/devstack/shapes'`. ✓
7. **Diverged from sketch.** `src/react/` was misnamed — the files have zero React imports; they're manifest→config helpers (`createDevstackDappKit`, `localnetWalrusOptions`) sitting on top of `@mysten/dapp-kit-core` (vanilla) and config shapes. Moved to `src/dapp-kit/`; the `./react` export became `./dapp-kit`. `react` / `@types/react` kept as deps because the Ink-based TUI needs them.
8. Deleted `PLAN.md` and `MIGRATION.md` at the package root; `notes/` retained.

**Type-leak sweep — landed, but diverged from the original 3-param phantom design.**

The original sketch was `Dep<TState, TData, TConsumerView>`. After looking at it from the plugin-author seat, two phantom slots that nobody ever cares about would have been worse ergonomics than the `<any>` they replaced. What shipped instead:

- **Public:** `Dep<TConsumerView>` — one type parameter. Plugin authors write `Dep<Package>`, `Dep<Keypair>`, `Dep<string>`. The brand is covariant via `__viewBrand?: TConsumerView`.
- **Internal:** the same `Dep` interface carries the runtime fields (`__producer`, `__pluginId`, `data`, `get`); the engine types these positions as `Dep<never>` (sentinel brand) when it holds Deps without caring about the view. No separate `DepInternal` interface to maintain.
- **Result:** zero `<any>` annotations across `src/plugins/`, `src/helpers/`, `src/runners/`. Eslint rule **not** added — we don't lint; the API design makes `any` unnecessary.

**Publish readiness — deferred to Phase 6.**

- `LICENSE` (Apache-2.0).
- `CHANGELOG.md` starting with `## 0.1.0`.
- `package.json` `"files": ["dist", "README.md", "LICENSE", "CHANGELOG.md"]`.
- `"prepublishOnly": "pnpm build && pnpm test && tsx scripts/smoke-test.ts"`.
- `scripts/smoke-test.ts`: imports the built `dist` from a clean temp dir, asserts each declared `exports.*` subpath imports cleanly. Validation borrowed in *spirit* from A's `scripts/smoke-test-build.ts`, not in code.
- Flip `"private": true` → off at this point.

---

### 3.10 Documentation

**README**: replace, don't edit. Outline:
1. One-paragraph what + why.
2. Install.
3. Minimum config (`devstack.config.ts` with sui + accounts + manifest).
4. CLI cheatsheet.
5. Test integration (vitest + playwright subsections).
6. Plugin reference.
7. Authoring plugins (link to `define` / `defineSchema` / runners).
8. Status + semver promise.

**File-level docstrings.** Currently 10/71. Target ~25/71. Priority modules: `engine/types.ts`, `engine/cycle.ts`, `engine/snapshot.ts`, `engine/identity.ts`, `factories/define.ts`, `runners/docker-network.ts`, `runners/docker-image.ts`, `runners/docker-one-shot.ts`, `cli/env.ts`, `persistence/lock.ts`. Write during the rename phase since every file gets touched anyway.

---

## 4. Sequencing (phases)

Six phases, each one PR-sized, ending in a shippable artifact. **Each phase must migrate at least one example app to the new package before merging** — the example is the proof.

### Phase 1 — Rename + type-leak sweep + React removal ✓ SHIPPED

No new features. The minimum landing that lets us proceed.

- `git mv packages/devstack-b packages/devstack`; renamed package, bin, `DEVSTACK_VERSION`; swept `devstack-next` / `devstack-b` strings. ✓
- Moved `src/react/` → `src/dapp-kit/` (files had no React imports; just misnamed). `./react` export → `./dapp-kit`. Kept `react` + `@types/react` for the Ink-based TUI. ✓
- Simplified `Dep` to single-param `Dep<TConsumerView>` (public) + `Dep<never>` (engine-internal sentinel). All plugin/helper/runner `<any>` annotations gone. ✓
- Deleted `PLAN.md`, `MIGRATION.md`. ✓

**Quality gates — all met.**
- `pnpm -F @mysten-incubation/devstack build && pnpm test` green (427/427 tests).
- Public-API snapshot test in place (`src/public-api.test.ts`).
- All 5 example apps + `create-devstack-app` template swapped to `@mysten-incubation/devstack` and typecheck green. Vitest/Playwright configs remain on `devstack-a` for now (Phases 3/4 own those).
- Zero `<any>` instantiations in `src/plugins/` / `src/helpers/` / `src/runners/`.

**Artifact.** A renamed package consumable by examples for config + dApp-Kit setup. Tests still depend on A.

---

### Phase 2 — Single-instance lock + cascade settling

- `persistence/lock.ts` with `withStackLock(fn)` (auto-detect, primary) + `withStackLock(env, fn)` (explicit overload) + lower-level `acquireStackLock` / `inspectStackLock`.
- Wire `withStackLock` into `up`, `apply`, `snapshot save/restore/delete`, `wipe`, `stack use/down`.
- `Engine.settle({ maxCycles })`; CLI verbs call `settle()` instead of looping `runOnce` themselves. Ships stable from 0.1.0 (no `@experimental` tag).

**Quality gates:**
- Two `devstack apply` in parallel: second errors with `StackLockBusyError` carrying the holder PID + holder-start-time + actionable remediation text (path to remove if stale).
- Stale-PID lock detection test passes (PID 1 stays held; random high PID is detected stale and replaced).
- Cold-cold start completes in one CLI invocation (publish + bindings + manifest all emitted in a single `apply` / `up`).
- **Example proof:** `pnpm -F @mysten-incubation/wallet apply` on a cold cache runs to completion in one invocation; running it twice in parallel produces a clean `StackLockBusyError` on the second instead of garbled docker / snapshot state.

**Artifact.** Concurrent invocations are safe; cold start is one-shot from the user's perspective.

---

### Phase 3 — Vitest harness redesign

- Keep existing `setup` / `teardown` shape (mostly right); add auto-detection of `appDir` (cwd-walk for `devstack.config.ts`) and `stack` (`DEVSTACK_STACK` env var) so callers pass `setup()` with no args in the common case.
- Add `readManifest<TExtras>()`, `readSnapshot()`, `devstackFixtures()`.
- Migrate `examples/_template/vitest.config.ts` and any other example using vitest off `devstack-a/vitest`.

**Quality gates:**
- `expectTypeOf(fixture.manifest).toEqualTypeOf<Manifest<Record<string, unknown>>>()` passes.
- App-extras typing works: `expectTypeOf(readManifest<{ foo: string }>()).resolves.toMatchTypeOf<{ extras: { foo: string } }>()`.
- The §3.1 "what you'd write" snippet compiles verbatim and runs against `examples/_template`.
- `examples/_template` vitest run uses `@mysten-incubation/devstack` only — no `devstack-a` import.
- Public-API snapshot updated and reviewed.

**Artifact.** Vitest examples no longer depend on A.

---

### Phase 4 — Playwright fixture + signer leasing

- Ship the pre-extended `test` and `expect` re-exports from `@mysten-incubation/devstack/playwright` with default fixtures: `manifest`, `rpcUrl`, `stack`, `signerPool`. No `engine` fixture (see §3.2).
- Add `webServer({ endpoint })` — fails loudly if the named endpoint is missing from the manifest (no localhost fallback).
- Add `setup` / `teardown` (same names as the vitest harness) for per-worker bring-up when playwright owns lifecycle.
- New `leasing/` module: `SignerPool.fromManifest(manifest)`, `Lease`. Pool is wired into the playwright + vitest default `devstackFixtures()` — test authors get it for free, no `leaseFixture()` factory.
- Migrate `examples/wallet/playwright.config.ts` (densest e2e coverage). Gated on §6 open question 3 (`connectAs` migration to dev-wallet team).

**Quality gates:**
- 4 concurrent test workers each get a distinct `e2e-${index}` stack; no port collisions; each worker prints its stack name on first fixture use.
- Leasing property test (100 random acquire/release sequences) passes the invariant "no two concurrent leases for the same name."
- Stress test: 4 parallel `withLease` calls on the same name serialize correctly; `acquire` times out cleanly after `acquireTimeoutMs`.
- Leaked leases produce a clear error with the acquire-site stack trace.
- The §3.2 + §3.3 "what you'd write" snippets compile verbatim and run against `examples/wallet`.
- `examples/wallet` e2e run uses `@mysten-incubation/devstack` only.

**Artifact.** Playwright examples no longer depend on A. Concurrent tests don't race on signers.

---

### Phase 5 — Exclusive Deps + CLI verb cleanup

- `exclusiveDep({ get, lockKey })` factory; `accounts.pool` gains an `exclusive` projection alongside `signer`.
- `runCycle` parallelism within a topo rank; conflict-graph coloring in `engine/scheduling.ts` (pure, unit-tested).
- Remove `runsAs` from `NodeImpl` (gated on §6 open question 1 — deprecate-and-warn vs remove cleanly).
- Rename `reset` → `wipe`; require `--yes`; add `--images`; add `stack drop` (gated on §6 open question 2 — `stack` as noun vs flag).
- Drop `codegen`; document `console` deferred.

**Quality gates:**
- Plugin-author seat: §3.5 "what you'd write" snippet compiles verbatim. `exclusiveDep` infers TState / TData from the lambda; no explicit generics needed.
- Consumer seat: `accounts.pool.get('exclusive', { name })` returns `Dep<Keypair>` (same view type as `signer`); engine handles the mutex transparently.
- Pure scheduling unit tests cover the coloring algorithm with random conflict graphs.
- Stress test: 4 parallel `runTransaction`s with overlapping publishers run 100 times with zero "object version is not the latest" errors.
- Benchmark: cold-start cycle time for `examples/wallet` improves measurably (record numbers in PR description) or the parallelism change is reverted.
- **Example proof:** at least one example's `devstack.config.ts` uses `pool.get('exclusive', { name })` for an overlapping-signer flow; the existing tests still pass.

**Artifact.** Engine scales with available concurrency; CLI verb table matches the design.

---

### Phase 6 — Publish readiness

- `LICENSE`, `CHANGELOG.md`, `files:` field, `prepublishOnly`, `scripts/smoke-test.ts`.
- Flip `"private": true` → off in `package.json` (kept on through Phase 1–5 so accidental publish wasn't possible).
- Replace `README.md` per outline.
- File-level docstrings on the ~15 priority modules.
- Delete `packages/devstack-a/` entirely; migrate any remaining example apps that still imported from A.

**Quality gates:**
- `pnpm publish --dry-run` produces a clean package; tarball contents reviewed.
- Smoke test passes against the built artifact in a clean temp dir: imports each declared `exports.*` subpath without error.
- README walks through a working minimum-config example that someone can copy-paste; the §3.1 + §3.2 + §3.5 "what you'd write" snippets are present and accurate.
- No remaining import of `@mysten-incubation/devstack-a` anywhere in the monorepo.

**Artifact.** A publishable `@mysten-incubation/devstack@0.1.0`. `devstack-a` is gone.

---

## 5. Working methodology — the HOW that produces high-quality results

These are cross-cutting practices, not phase-specific. Treat each as a requirement.

### 5.1 Design-before-code, per subsystem

For every subsystem in section 3, the first commit on the branch is a **design doc update** (this file), not code. The doc commit lists:

- Use cases enumerated from A's tests + example consumers (with file:line refs).
- The API sketch in ≤30 lines of TS signatures.
- 3-5 alternatives considered with one-line dismissals.
- Open questions, explicitly called out.

The reviewer signs off on the design doc commit *before* implementation begins. This prevents "the code is here, the design is implied" — a failure mode that produced A's 8-discriminator surface.

### 5.2 Reviewer rubric (use on every PR)

Each PR is reviewed against the same seven questions. If any answer is "no", the PR doesn't merge:

1. **Plugin-author seat?** Pick the most user-facing line of the diff — a plugin author or test author writing it. Does it require `<any>`, eslint-disables, explicit generics, manual casts, or knowledge of engine internals? If yes, the API is wrong. (See §2 principle 8.)
2. **Ergonomic?** Can a user write the minimum config in one screen of code without consulting docs?
3. **Type-safe?** Zero new `<any>` instantiations in public types; new APIs return inferred types end-to-end.
4. **Intuitive?** Reading the API name + signature, can you predict what it does without reading the implementation?
5. **Fits B's grain?** Producers, Deps, runners, plugin schemas — not parallel concepts.
6. **Not a port from A?** Either the use case is solved differently, or there's a written argument for why the same shape is right despite being convergent.
7. **Validated by an example?** At least one example app uses the new API and its tests pass.

### 5.3 Tests precede implementation

For each new public function:
1. Write the type test (`expectTypeOf`) and the behavior test against the proposed signature.
2. Watch the tests fail to compile / run.
3. Implement until they pass.

For each new engine touchpoint (phases 2, 5, 6 settling):
1. Write the property test or stress test for the failure mode.
2. Run it; verify it actually fails on the current behavior.
3. Implement; verify it passes consistently (100 runs, not 1).

### 5.4 Example apps are the ground truth

Every phase migrates at least one example. The example is what proves the API works in user code — not the unit tests of the new module. If an example needs adapter shims to migrate, the API is wrong; fix the API, not the example.

Migration order across phases is deliberate:
- Phase 1 (rename): all 5 examples flip their config import; tests stay on A.
- Phase 3 (vitest): `_template` migrates.
- Phase 4 (playwright + leasing): `wallet` migrates.
- Phase 6 (final): remaining examples migrate.

If an example fails to migrate cleanly, the phase doesn't ship. Roll back, redesign.

### 5.5 Type-safety discipline

- `tsc --strict` already on; keep it.
- We do not run eslint. Type safety is enforced by API design and `tsc` — not by lint rules. If you reach for `<any>` while writing a plugin, that's a signal to rethink the API, not to add a disable comment.
- The legitimate `any` sites that remain (engine-internal `Provides<TState>`'s contravariant recipe slots, the `dep()` factory's implementation overload) are documented in `engine/types.ts` with comments explaining the variance reasoning.
- Type tests (`expectTypeOf`) live in `*.test-d.ts` files; run as part of `pnpm test`.

### 5.6 Public surface is finite

- `src/index.ts` exports get a snapshot test (phase 1). New exports require a test update — surfaces in review.
- Subpath exports (`./helpers`, `./plugins`, `./shapes`, `./vitest`, `./playwright`, `./persistence`) get the same treatment.
- Internal-only types live in `src/_internal/` and never appear in any `index.ts`.

### 5.7 PR shape

Every PR contains:
1. The design doc update (if it's a new subsystem).
2. The implementation, scoped to one phase.
3. The example app migration that proves it.
4. The CHANGELOG entry.
5. The public-surface snapshot diff, if any.

Sub-1000-line PRs are the target. Anything larger gets split.

### 5.8 Rollback and reversibility

Each phase is one PR. If post-merge feedback reveals a design problem, the phase reverts cleanly (single commit revert) and re-enters design. Phases do not depend on each other's *implementation details* — only their *artifacts* (the lock helper exists; the settle method exists). This keeps the blast radius of any one regression small.

### 5.9 Engine changes get extra scrutiny

Phases 2 (lock + settle) and 5 (exclusive Deps + scheduling) touch engine semantics. For these:
- A second reviewer signs off on the engine diff specifically.
- The PR includes a "what could go wrong" section listing the failure modes considered.
- Benchmarks against `examples/wallet` cold start are recorded in the PR description.
- The change ships behind no flag — flags are debt. Either it's right and we ship, or it's wrong and we don't.

### 5.10 What "done" means

This stage is done when:
- `packages/devstack/` builds, tests, and publishes (dry-run) cleanly.
- `packages/devstack-a/` is deleted.
- No file in the monorepo imports `@mysten-incubation/devstack-a`.
- Every example app's `pnpm dev`, `pnpm test`, and `pnpm test:e2e` pass against `@mysten-incubation/devstack` only.
- README, CHANGELOG, file-level docstrings present at the bar in section 3.10.

Not before.

---

## 6. Risks & open questions

**Resolved during Phase 1:**

- ~~**TUI fate.**~~ Kept Ink + `react` + `@types/react` as runtime deps; `src/tui/` is internal CLI rendering. The "drop React" principle (§1, §2.7) only ever applied to consumer-facing React bindings, which were the misnamed `src/react/` helpers (moved to `src/dapp-kit/`). Plugin/test authors get no React dependency from devstack.
- ~~**`SignerPool` construction.**~~ Settled as `SignerPool.fromManifest(manifest)` (single canonical entry) with the pool also exposed as a default worker fixture so test authors don't construct it explicitly. See §3.3.
- ~~**`<any>` ban via eslint.**~~ Dropped — we don't lint. The single-param `Dep<TConsumerView>` redesign removed the need; remaining `any` sites in engine internals are documented with variance reasoning. See §3.9.

**Resolved before Phase 2 starts:**

- ~~**`Engine.settle` public vs CLI-private.**~~ Public from 0.1.0, no `@experimental` tag. Cascade semantics are now part of the semver contract; we change them with intent. See §3.6.
- ~~**`withStackLock` lock granularity for multi-worker cases.**~~ One exclusive lock per stack realpath. No shared/exclusive split, no recursion. Harnesses are structured so contention doesn't arise (vitest globalSetup is the only acquirer in a vitest run; playwright workers each use their own per-worker stack). See §3.7.

**Resolved during Phase 4:**

- ~~**`connectAs` migration.**~~ Devstack owns the playwright UI helpers (`connectAs`, `selectAccount`, `waitForBalanceUpdate`) until the dev-wallet team has bandwidth + a `/playwright` subpath. Shipped at `@mysten-incubation/devstack/playwright` with no deprecation marker — see §3.4. No compat shims; brand-new code path, fully owned.

**Still open, must decide before the phase that depends on them:**

1. **Removing `runsAs` (Phase 5).** Breaking change to plugin authors even though it's dead engine config today. If any user-space plugin sets it expecting future support, we silently change semantics. Decision: leave `runsAs` parsed-and-warned-as-deprecated for one release, *or* remove cleanly and document in CHANGELOG? *(No `devstack-a` users currently set `runsAs` — this question is mostly a 0.x → 1.x semver concern.)*

2. **`stack` as first-class CLI noun vs flag (Phase 5).** Today it's both. Cleaner cut: only `--stack`, replace subcommands with `devstack list --stacks` etc. Case for keeping `stack` as a subcommand: `stack use` writes the active-stack pointer (no clean flag equivalent).
