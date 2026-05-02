# Vitest integration

**Verdict**: B − Right shape, untested in practice. `AccountPool` is a sound primitive, but no in-tree consumer exercises chain mode, so the friction it nominally addresses ("faucet-per-test in the hot path") is solved on paper but not in code.

## Architecture

The split into a **config-load** entry (`./vitest`) and a **runtime** entry (`./vitest/runtime`) is the load-bearing design decision and is well-justified inline (`index.ts:6-14`): Vitest 2.x's config loader is plain Node ESM with no `.js`→`.ts` fallback for transitive imports inside external packages, while vite-node (used for test files + globalSetup) does. Keeping `index.ts` import-free except for `vitest/config` itself sidesteps the trap. The cost is duplicated documentation surface and a minor footgun: a user who imports `getSessionAccountPool` from `@mysten-incubation/devstack/vitest` instead of `/runtime` will get a working type but a runtime miss.

`AccountPool` is the right primitive — deterministic BIP-39 derivation (`m/44'/784'/<i>'/0'/0'`), idempotent `seed()` via a captured promise, parallel `Promise.all` faucet calls, lease/release with a waiter queue. The decision to **block on exhaustion rather than throw** is documented in `notes/friction.md` M9 and is correct: a stalled hook timeout is a clearer signal than a stochastic subset of failing tests.

## Problem fit

Friction `M9a/b/c` frames the pain as "5–10s faucet calls in the hot path." The pool *does* address this for the chain-mode case: `seed()` runs a parallel pre-fund of all 10 accounts up front (one wall-clock window for N requests), and `ensureFunded` short-circuits via `suix_getBalance` so reruns are O(0) faucet calls. But **no test in-tree actually uses chain mode** — `grep "chain: true"` returns only docs and the typedef itself. All four `examples/*/vitest.config.ts` are bare `defineDevstackVitestConfig()`, and the only test files in those apps are e2e (Playwright). `pnpm -r test` is `passWithNoTests` across the board. The pool's load-tested behavior is therefore unverified beyond the design intent.

## Integration

The seam with manifest is clean: `globalSetup.ts:36-44` reads `<cwd>/.devstack/stacks/<DEVSTACK_STACK ?? 'test'>/manifest.json` (overridable via `DEVSTACK_MANIFEST_PATH`), and apps' `package.json` `test` scripts already set `DEVSTACK_STACK=test` so unit tests don't trample dev state. Service URLs are pulled by `services.find((s) => s.name === 'sui-rpc')`, which is loosely typed (`as Array<{ name; url }>`) — `SerializedRegistry.services: unknown[]` in `manifest-types.ts:28` means a manifest-version drift wouldn't be caught at typecheck time. Errors are actionable (`"Run \`pnpm localnet:up --stack test\` first"`).

`provide('devstack', { rpcUrl, faucetUrl, manifest })` publishes the context, but there's no `declare module 'vitest'` augmentation shipped — friction note M9 explicitly punts this to consuming apps. With zero in-tree consumers, the typing path is also unverified.

## Customizability + gaps

Three escape hatches: `DEVSTACK_POOL_SIZE`, `DEVSTACK_POOL_FUND_EACH`, `DEVSTACK_SKIP_PREFUND`. Reasonable for a Phase 1 surface. **Fresh-localnet-per-file via testcontainers — the explicit Phase 1+ goal in `CLAUDE.md:46-48` — is not implemented.** Friction note M9 acknowledges this: "Per-spec testcontainers isolation is wired in the schema but not in the runtime — the helper still expects a single `devstack up`-managed chain." That's the headline gap.

Other gaps: `keypair(index)` is sync but provides no atomic "lease index N" handle, so the doc warns the caller is responsible for not racing themselves — fine for the publish-as-account-0 case, weaker for general use. Vitest worker parallelism (`pool: 'forks'`) means each worker gets its own globalSetup invocation in some configurations; the pool is per-worker, not cross-worker, and 10 accounts × N workers × deterministic mnemonic = **all workers fund the same addresses**. This is correct (idempotent funding), but two workers leasing index 0 in parallel will see the same on-chain object set — there is no per-worker mnemonic salting or address-space partition.

## Testing

There are **zero tests of the vitest integration itself** under `src/vitest/`. The pool, the env-var parsers, the manifest path resolution, the lease/release/waiter dance — none of it has a unit test. The only validation is the M9 "verified" note: `pnpm -r test` passing as `passWithNoTests`, which validates the config-load surface but exercises nothing else. Given the blocking-on-exhaustion semantics and the funder retry path are subtle, this is the second headline gap.

## Top recommendations

1. **Add a real consumer** — at least one example with `chain: true` so the pool is exercised by CI.
2. **Add `accountPool.test.ts`** covering lease/release/waiter semantics, blocking-on-exhaustion, idempotent seed.
3. **Implement testcontainers-per-file isolation** (the M9 punted promise).
4. **Add per-worker address-space partition** so two workers can't collide on the same account.
5. **Ship a `declare module 'vitest'` augmentation** so `expect.extend` consumers don't have to write it themselves.
