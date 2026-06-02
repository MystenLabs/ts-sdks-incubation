# Devstack template + codegen reshape + restore-resume — plan & backlog

Origin: user feedback after testing `create-devstack-app`. Three approved directions:
- **Full reshape** of generated codegen output.
- **Interactive picker** for template plugin selection.
- Fix all reported bugs (order not important — "fix them all").

This is the durable backlog. Triage markers: `[ ]` todo · `[~]` in-flight · `[x]` done · `[?]` needs decision.

---

## WS1 — Restore-resume bug (devstack core + dashboard)  [x] code-complete (Docker e2e pending)

Root cause (verified): dashboard `restoreSnapshot` (`plugins/dashboard/schema/root.ts:388`) → `domain.restoreSnapshot` (`substrate/runtime/control-plane/domain.ts:133`) runs `runRestore` in-process while supervisor is live. `runRestore` removes captured containers (`orchestrators/snapshot/restore.ts:1039`, `:263`) and relies on next acquire to rebuild — which never fires. `command-loop.ts:141-147` lumps `snapshot.restore` with list/delete/wipe (no re-acquire), unlike `stack.restart` (`:53-75`). Status stuck because `projection/update.ts:182-193` maps all `snapshot.*` to `withTouched({})`.

- [x] New `submitCommand` seam (control-plane `service.ts` + supervisor `start-supervisor.ts`) routes dashboard restore through the command-loop, awaiting real completion. Replaces in-process `domain.restoreSnapshot`.
- [x] `command-loop.ts` `snapshot.restore` own case: injected handler → `doSelectiveRestart(planFullDrain(graph))` + `maybeRunPostAcquire`.
- [x] Status transitions: `projection/update.ts` capture→`snapshotting`/`running`, restore→`restoring`; new phases in persisted `CyclePhaseSchema`. Re-acquire drives per-row acquiring→ready.
- [x] Typecheck + dashboard/supervisor unit tests pass.
- [ ] Docker + dashboard e2e: `devstack up` → capture (rows show snapshotting) → restore (containers back, endpoints live, rows ready, NO manual restart). Deferred to consolidated verification pass.
- Follow-up noted: `domain.restoreSnapshot` now dead-called; restore-failure still reports `ok:true` (handler is the error-publishing seam). Low priority.

## WS2 — Codegen full reshape (devstack emitters + orchestrator + all consumers)  [~]
Phase 2a (producer: emitters/orchestrator/vite/`@devstack-dev` alias/per-network ids/objects) — [~] RE-RUNNING. First run completed (typecheck + 1601 tests) but its working-tree edits were CLOBBERED by a concurrent agent running a git op (checkout/restore/stash) — the exact no-git-in-parallel-agents hazard. WS1 + consumer edits survived; only producer/codegen files reverted. Re-running SOLO (no concurrency) and verifying git persistence immediately after. LESSON: never run git-state-changing agents in parallel; verify `git status` persistence after each agent batch.
Phase 2a — [x] DONE + Docker-VALIDATED (connect-four, deepbook-trader w/ deepbook+coins+capture objects, private-content w/ seal+walrus+bindings incl. 4 walrus nodes). All generated artifacts match spec; dev-extras 600 perms; old files pruned. No producer defects.
Phase 2b (consumer migration) — [x] DONE for 4 examples + tsconfig include/exclude fix (composite TS6307). connect-four/deepbook-trader/private-content typecheck CLEAN (exit 0). token-studio: same fix applied, pending a Docker apply to materialize generated files (identical pattern, expected clean). _template migration folded into WS3.
Follow-up (low pri, producer): codegen could MANAGE the `@devstack-dev` tsconfig path + include glob like it manages `.gitignore`, removing the per-example hand-edit footgun. Also rename stale `DappKitConfigBindings` type → `DevWalletConfig`.

New `generated/` = runtime-imported only. Everything else → `.devstack/`.

Target `generated/`:
- `config.ts` — combined runtime config: `{ network, networks{chain,mode,rpc,faucet,graphql}, packages{mvr,packageId,byNetwork}, objects }` (NOT accounts, NOT dev-wallet).
- `seal.ts` / `walrus.ts` / `deepbook.ts` — plugin siblings (name-keyed aggregates), emitted only when plugin present.
- `coins.ts` — unchanged aggregate.
- `bindings/` — Move codegen, stays (genuinely runtime).

Moved to `.devstack/stacks/<stack>/generated-extras/`:
- `accounts.ts` — dev-only name→address (dev-wallet wiring + playwright `connectAs`).
- `dev-wallet.ts` — secret-bearing `{walletUrl,pairUrl,protocolPaths,chain}` (today's `dappKitConfig`), `0o600`.

Deleted: `accounts.ts`/`accounts/`, `packages.ts`/`package/`, `services.ts`, `extras.ts` (verify postgres creds home first), `sui/network.ts`, `dapp-kit/config.ts`.

New capability — per-network package ids: extend `localPackage`/`knownPackage` options with `networks?: Record<net,{packageId, objects?}>`; codegen merges resolved-local + declared-prod into `packages[name].byNetwork`. `config.network` selects active (env `VITE_DEVSTACK_NETWORK`, default `local`). Lets the same generated shape ship to testnet/mainnet against pre-deployed contracts.

- [ ] New `@devstack-dev` tsconfig/vite alias → `.devstack/.../generated-extras` (template + connect-four).
- [ ] Orchestrator: `aggregateOnly` decl flag so pure aggregate contributors stop double-emitting singletons; new `config.ts` bucket; route dev-extras emitters to `.devstack`.
- [ ] Rewrite emitters: `sui`, `package` (+`index.ts` options), `account`, `wallet`, `seal`, `deepbook`, `walrus`.
- [ ] Update consumers (5 examples + template — authoritative list from fact-find):
  - `examples/token-studio` (`dapp-kit.ts`: accounts/dappKitConfig/suiNetwork; `lib/deployment.ts`: accounts/coins/packages/services)
  - `examples/private-content` (`dapp-kit.ts`: accounts/dappKitConfig/suiNetwork; `lib/walrus.ts`: walrus; `lib/deployment.ts`: accounts/packages/sealBindings/services/walrus; `lib/vault-transactions.ts` + `lib/queries.ts`: bindings/vault; `e2e/seal-flow.spec.ts`: accounts via RELATIVE path)
  - `examples/deepbook-trader` (`dapp-kit.ts`: accounts/dappKitConfig/suiNetwork; `App.tsx`: accounts/coins/deepbookBindings/suiNetwork)
  - `examples/connect-four` (`dapp-kit.ts`: accounts/dappKitConfig/suiNetwork; `App.tsx`: accounts/packages/bindings)
  - `examples/_template` + `packages/create-devstack-app/template` (`dapp-kit.ts`: accounts/dappKitConfig/suiNetwork; `App.tsx`: packages)

### WS2 firm facts (from fact-find)
- `extras.ts` is fed ONLY by user `defineDevstack({ extras })` — NO plugin/postgres contributes. Removing it just needs to handle that user hook (grep examples for `extras:`; likely none). postgres writes its own `postgres/<name>.ts` (sensitive), unaffected.
- Captured object ids: `LocalPackageResolved.captured: Record<string,string>`, user-keyed via `capture` option (e.g. deepbook-trader `capture: { registryId: '::registry::Registry', ... }`). Currently NEVER reach codegen — new `objects` surface.
- `@generated` alias = devstack vite plugin (`build-integrations/vite/index.ts`), resolves manifest `codegen.generatedDir`, stack from `DEVSTACK_STACK` env. `@devstack-dev` mirrors this → `.devstack/stacks/<stack>/generated-extras`. tsconfig `paths` entry needed too.
- `services.ts` IS imported (token-studio, private-content `lib/deployment.ts`) — NOT dead as earlier thought; its network data folds into `config.networks`. Migrate those consumers, don't just delete.

## WS3 — Template + example app overhaul  [~]
Design: `design-template.md` (per-plugin demo panels + interactive picker + dev/prod wallet split + test-stack). User decisions: per-plugin panels; interactive picker; deepbook must be a true one-liner (investigate plugin — DONE, see below).
- [x] Phase A: `examples/_template` rebuilt — counter (core) + seal + walrus panels, dev/prod dapp-kit split (no runtime accounts; `dapp-kit.dev.ts` holds the dev-only slot), test-stack playwright, real e2e + vitest unit, fenced for picker. Binding-name assumptions flagged for Phase E.
- [x] Phase D: `create-devstack-app` picker (@clack/prompts) + fence stripper + plugin-manifest + sync-template rework (deleted brittle cutover fixups, shared SKIP, manifest validation). typecheck + 18 unit tests pass. tsdown bundles clack.
- [ ] Phase E1: Docker apply core+seal+walrus `_template` + typecheck + fix binding mismatches. IN PROGRESS.
- [ ] DEEPBOOK plugin one-liner (devstack core): investigation CONFIRMS feasible — SDK + pools + codegen already work locally; gap is the plugin doesn't OWN the Move. Fix: ship DeepBook+Pyth Move as `deepbook/bootstrap-assets` (mirror seal/walrus), have `deepbook({mode:'local'})` synthesize the `localPackage('deepbook'/'pyth')` members + default pool/seed presets; make `package`/`pools` optional overrides. deepbook-trader currently vendors `move/vendor/{deepbookv3,deepbook-sandbox}` (~9.7k LOC) — that moves into the plugin.
- [ ] Then add deepbook panel/lib/spec + fenced config/App/package.json to `_template` (manifest already reserves it).
- [x] Drop `accountAddressByName` from template runtime (done in Phase A dapp-kit split).

## WS4 — Testing DX  [ ]
- DECISION (user): tests run on a SEPARATE stack name (e.g. `test`) vs the dev stack (`primary`). Do NOT attach to the running dev supervisor. The supervisor already isolates stacks by name, so a distinct `DEVSTACK_STACK=test` avoids the exit-40 "supervisor live" collision entirely.
- [ ] Playwright config / `test:e2e` script: set `DEVSTACK_STACK=test` (distinct from dev's `primary`) so e2e works while `pnpm dev` runs. Update the webServer hostnames/baseURL to the `test` stack.
- [ ] Tests should run without a separate manual `apply` step (the test-stack webServer brings its own up).
- [ ] Real tests so `pnpm test` doesn't fail on empty suite.
- [ ] Remove tracked `test-results/` dir (gitignore already covers it — committed before the rule).

---

## Decisions locked (defaults, not re-asking)
- connect-four (an example, not a production app) MAY import accounts from `@devstack-dev`; the **template** does not use accounts at runtime. Satisfies the "no accounts in prod" intent.
- `bindings/` stays in `generated/` (runtime-imported).
- `config.network` via `VITE_DEVSTACK_NETWORK`, default `local`.
- Dev secrets via `@devstack-dev` alias (not a `generated/.dev/` subfolder).
- Rename `dappKitConfig` export → `devWallet` (it was never dapp-kit config).
- `objects` keyed `objects.<package>.<captureName>`.

## Open to verify during impl (factual, not user calls)
- What feeds `extras.ts` today (postgres creds?) — find a home before deleting.
- Confirm no out-of-repo consumer of `services.ts`.
- `LocalPackageResolved.captured` ids are computed but never reach codegen today — new `objects` map closes that gap.
