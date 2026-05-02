# Architecture review (2026-05)

Deep architectural reviews of every plugin, action type, runtime subsystem, helper, CLI surface, integration adapter, and example app — one focused report per concern. Each review covers verdict, architecture, problem fit, integration, customizability + gaps, testing, and 3–5 actionable recommendations.

## Reviews

### Plugins

| # | Subject | Verdict |
|---|---|---|
| 01 | [sui plugin](./01-sui-plugin.md) | B+ — solid; sed-driven yaml patching is brittle |
| 02 | [walrus plugin](./02-walrus-plugin.md) | B — works, but nginx TLS-terminator and stale doc claims |
| 03 | [seal plugin](./03-seal-plugin.md) | A− — cleanest demo of build-then-extract paying off |
| 04 | [wallet-server plugin](./04-wallet-server-plugin.md) | B — module-level state + getStatus race we hit live |
| 05 | [codegen plugin](./05-codegen-plugin.md) | A− — zero tests despite recent path-resolution fix |
| 06 | [imports plugin](./06-imports-plugin.md) | A− — strongest test coverage in the repo |
| 07 | [vite virtual-module plugin](./07-vite-virtual-module-plugin.md) | B — wasm-url module documented but unimplemented |
| 08 | [vite supervisor plugin](./08-vite-supervisor-plugin.md) | B+ — should be `frontend()`, not `vite()` |

### Action types

| # | Subject | Verdict |
|---|---|---|
| 09 | [build + service actions](./09-build-service-actions.md) | Build B+ / Service C — Service is overloaded into 4 shapes |
| 10 | [publish action + move-package](./10-publish-action.md) | A− — solid skip cascade; `<` capture rule needs docs |
| 11 | [register/seed/emit actions](./11-register-seed-emit-actions.md) | Register C+ / Seed B / Emit A− |

### Runtime

| # | Subject | Verdict |
|---|---|---|
| 12 | [reconciler + topo executor](./12-reconciler-topo.md) | B+ — `getStatus`-vs-hash-mismatch priority is a real bug |
| 13 | [supervisor + one-shot](./13-supervisor-one-shot.md) | B− — `devstack up` defaulting to `--once` is a design bug |
| 14 | [manifest reader/writer/types](./14-manifest.md) | B − no atomic write; migration table untested |
| 15 | [accounts + active-stack + file-watcher](./15-accounts-stack-watcher.md) | A− — cleanest extractions; two missing test files |
| 16 | [status-renderer + hash + scope-actions](./16-status-renderer-hash-scope.md) | B − Date/Map/Set silently collide in stableHash |

### Core + helpers

| # | Subject | Verdict |
|---|---|---|
| 17 | [core types + plugin SPI](./17-core-types-plugin-spi.md) | B+ — `LocalnetActionRunContext` narrowing leaks at runtime |
| 18 | [signers + keystore + sui-client](./18-helpers-small.md) | A− — right size, zero unit tests |
| 19 | [imported-package + upstream-source](./19-imported-package-helpers.md) | A− — genuinely general; no build hooks for prebuild scripts |
| 25 | [registry](./25-registry.md) | A− — quietly load-bearing; no `registry.test.ts` |

### CLI

| # | Subject | Verdict |
|---|---|---|
| 20 | [long-running CLI (up/watch/args)](./20-cli-up-watch.md) | C+ — `up` and `watch` are accidental synonyms |
| 21 | [one-shot CLI subcommands](./21-cli-one-shot.md) | B+ — `stack drop --force` is a foot-gun |

### Adapters

| # | Subject | Verdict |
|---|---|---|
| 22 | [react adapter](./22-react-adapter.md) | A− — `globalThis.__devstackDAppKit__` shim is the wart |
| 23 | [playwright integration](./23-playwright-integration.md) | C+ — two-supervisor dance has a real seam |
| 24 | [vitest integration](./24-vitest-integration.md) | B − right shape, no in-tree consumer exercises chain mode |

### Examples

| # | Subject | Verdict |
|---|---|---|
| 26 | [private-content example](./26-private-content-example.md) | B+ — densest stress test; thin as a real product |
| 27 | [token-studio + arena + wallet](./27-other-examples.md) | B+ — strong consistency; missing NFT example |

### Cross-cutting

| # | Subject | Verdict |
|---|---|---|
| 28 | [docs + design journal](./28-docs-and-journal.md) | B − stale walrus/react comments; broken docs-build code fences |
| 29 | [build toolchain](./29-build-toolchain.md) | B+ — no build-output smoke test; that's how the tsup→tsdown migration broke |
| 30 | [example app authoring flow](./30-app-authoring.md) | B− — runtime is SE-2 caliber; on-ramp is ~70% missing |

## Top cross-cutting findings

These show up in multiple reviews and are worth addressing as themes rather than per-component fixes:

1. **The `getStatus`-as-warm-path-rehydrator pattern is duplicated everywhere.** sui.localnet, seal.key-server, walrus.register, sui.accounts all manually re-call `registerService` from `getStatus` because the reconciler skips `run` on `ok=true`. Need a `provides: { registry: { ... } }` slot the reconciler can replay. (build/service, register/seed/emit, wallet-server)
2. **`getStatus.ok=true` overrides `inputs` hash mismatch.** A correctness bug — input changes are silently ignored if `getStatus` is defined and returns ok. Affects seal especially. (reconciler)
3. **`devstack up` defaulting to `--once` (which tears down) is a UX trap.** Real users have hit it (us, debugging walrus). Wallet-server dies after every `up`. (supervisor, CLI)
4. **The wallet-server connect race.** Two supervisors (globalSetup's runOnce + webServer's watch) race on the in-process server; getStatus mistakes the orphaned port for a healthy server, manifest token goes stale. (wallet-server, playwright)
5. **Zero unit tests for ~12 of the 30 components reviewed.** sui plugin, codegen plugin, vite plugin (both), seal plugin, registry, helpers/{signers,keystore,sui-client,match-type,seed-shared-object}, runtime/{file-watcher,active-stack}, vitest integration. The recent codegen path-resolution and tsup→tsdown bugs would have been caught.
6. **Stale comments in source.** `react/walrus.ts` claims `virtual:devstack-walrus-wasm-url` exists; `walrus/index.ts` claims a `_walrus/node-<idx>` vite proxy exists. Neither does. Easy cleanup.
7. **Massive boilerplate duplication across the four examples.** `dapp-kit.ts` byte-identical, `Card.tsx`/`shortAddress`/`labelFor` flagged "fourth copy" in source. No shared `@mysten-incubation/ui` yet.
8. **No `create-devstack-app`.** The biggest gap to scaffold-eth-2 caliber experience. ~12 boilerplate files per app today.
9. **Action type `Service` is overloaded.** Used for long-running containers, one-shot containers (`walrus.deploy`), host processes, and network setup. Each has different semantics; a split would clean up plugin boilerplate.
10. **Manifest writer is non-atomic.** `writeFileSync` directly — a `kill -9` mid-write corrupts state. 3-line fix (write to `.tmp` then rename).

## Methodology

Each review was conducted by a focused sub-agent reading the relevant source, sibling tests, and consumers, then producing a structured report under 800 words. Outputs reflect what's checked into the repo as of 2026-05-01.

The reviews are honest about what works and what's brittle. Where a sub-agent's verdict reads optimistic, it usually means the surface is small and well-bounded; where it reads critical, the issue is concrete and reproducible.
