# Phase 0d — multi-network deployment: implementation checklist

Branch `mh/devstack-deployment-runtime`. Builds on the 0a flip (generated `config.ts` reads
`loadDeployment()`; `requireId`/`requireValue`/`optionalValue`; no `activeNetwork`). Co-existence
lives at the injected-blob / Vite MERGE layer — the stack stays single-network.

## Sub-decisions (taken)
- **D1** boot writes the ENVELOPE on disk (`{ defaultNetwork, networks: { <net>: NetworkDeployment } }`) — one key for a single-network stack; uniform merge.
- **D2** `config.networkNames` / `config.defaultNetwork` typed as a LITERAL tuple/union (emitted into `src/generated/deployment.ts`) so dapp-kit `switchNetwork` is type-checked. Consequence accepted: switching to an un-deployed network throws in dev.
- **D3** rename manifest field `codegen.idsFile` → `codegen.deploymentFile`.
- **D4** load committed `deployments/<net>.ts` via dynamic `import()` in an async Vite `config` hook; esbuild-transform fallback if bootstrap import is fragile.
- **D5** keep the deprecated single-file `ids` Vite option one release as a fallback path.
- **D6** keep the per-package `byNetwork` wiring as its own commit (commit 3).

## Naming (deployment family)
`NetworkDeployment` (per-network unit) inside `DevstackDeployment` envelope. Global
`__DEVSTACK_DEPLOYMENT__`; file `.devstack/stacks/<s>/deployment.json`; env `DEVSTACK_DEPLOYMENT_FILE`;
verb `dump-deployment`; schema file `orchestrators/codegen/id-config.ts`→`deployment.ts`; hand-written
prod `deployments/<network>.ts`. `requireId` kept. App object stays `config`.

## Commit ordering (green at each step)
1. **Pure rename sweep** (DOING — agent). Persisted-file + schema layer: `IdConfig*`→`Deployment*`,
   `assembleIdConfig`→`assembleDeployment`, `devstack-ids.json`→`deployment.json`,
   `DEVSTACK_IDS_FILE`→`DEVSTACK_DEPLOYMENT_FILE`, `dump-ids`→`dump-deployment`, manifest
   `idsFile`→`deploymentFile`. Single-network semantics retained; `__DEVSTACK_IDS__` global +
   `DevstackIds` interface + adapter + `resolve*()` LEFT ALONE. Regenerate trees. Green.
2. **Multi-network envelope + merge, behind the adapter.** `assembleDeployment` returns the envelope;
   boot writes an envelope; Vite `resolveInjectedDeployment` does the merge; add `deployments` option
   (default `{}`). `config-runtime.ts`: `__DEVSTACK_IDS__`→`__DEVSTACK_DEPLOYMENT__`,
   `DevstackIds`→collapse into `DevstackDeployment` envelope, drop `networkDeploymentFromIds` adapter,
   `loadDeployment` reads the envelope directly. `resolve*()` STILL PRESENT. Regenerate. Green.
   - Merge algo: committed `deployments/*` validated → `{...committed}`; dev overlays live local
     (`local:true`, default = live network); `command==='build'` drops local-mode, ships committed
     only (null → loud throw if empty).
3. **Per-package `byNetwork` wiring.** `deploymentFromBucket` reads `byNetwork` (today dropped at
   service.ts ~1115, only `packageId`) so `forNetwork(testnet).packages.*.id` resolves; per-network
   `objects` too. Regenerate. Green.
4. **Strict generated type** `src/generated/deployment.ts`: `AppPackages` (exhaustive),
   `AppNetworkDeployment extends NetworkDeployment` (required packages/mvrOverrides), `ProvidedNetwork`
   (declared non-local network union), `ProvidedDeployments = Partial<Record<ProvidedNetwork, …>>`, and
   the literal `NETWORK_NAMES` tuple for D2. tsc-green on clean clone (Partial/empty). Regenerate.
5. **Sugar re-pointing + resolver removal (COUPLED — one commit, must not split).** Re-point
   `config-bindings.ts`/`sui/codegen.ts`/`coin/codegen.ts` sugar (`resolveNetwork()`/`resolveNetworks()`/
   `resolveValue(...)`/`resolveId(...)`) to deployment-API expressions; delete `resolve*()` from
   `CONFIG_RUNTIME_SOURCE`; update `idsImportSymbols`/import-symbol logic. Regenerate ALL trees in the
   same commit. Update `config-bindings.test.ts` + `move-bindings-codegen.test.ts` expected exprs.
   Migrate `templates/{app,ts}/tests/e2e/counter.test.ts` off `resolveActiveNetwork` →
   `config.forNetwork(config.defaultNetwork)`. Green.
6. **`dump-deployment --network <net>`**: emit typed TS `deployments/<network>.ts`
   (`export const deployment = {…} satisfies AppNetworkDeployment`) from a live deploy; no-flag keeps
   raw envelope JSON to stdout. Green.
7. **App wiring**: dapp-kit `networks: config.networkNames`, `defaultNetwork: config.defaultNetwork`
   across examples + template (D2 makes this type-check); FULL MVR overrides (emit a `types` override
   map too, source per-network from `config.forNetwork(net)` — the user wants this); example
   `vite.config.ts` `deployments` where docs demo a real-network deploy; docs. Green.

## 0e — per-network services (IN SCOPE, owner-confirmed)
Everything — seal/walrus/deepbook/coins — must resolve correctly when the app switches to
testnet/prod, not just rpc + packages + mvrOverrides. So service buckets stop baking
`dep = forNetwork(defaultNetwork)`; each becomes a per-network accessor consistent with
`config.forNetwork`.

- **8. Service buckets → `forNetwork(net)`.** `coin/deepbook/seal/walrus` codegen emits
  `export const <svc> = { forNetwork: (net) => ({ …requireValue(loadDeployment().forNetwork(net), ns, key)… }) }`
  (instead of a default-network-baked object). The `values` channel is already per-network (each
  `NetworkDeployment` carries its own `values`); the live path populates the live network's values via
  `assembleDeployment`, committed networks supply theirs in `deployments/<net>.ts`.
- **Strict type narrows `values`.** Commit 4's `AppNetworkDeployment` must require each service
  namespace/key the app declares (e.g. `values['deepbook:main'].poolId`), so a hand-written
  `deployments/testnet.ts` is compile-checked to include deepbook pools / walrus+seal endpoints / coin
  types. This needs the service plugins to declare their value namespaces+keys to the strict-type
  emitter (extra coupling vs the packages-only narrowing).
- **9. Service consumers.** Update `examples/{deepbook-trader,private-content,token-studio}` (+ any
  template) to read `<svc>.forNetwork(currentNetwork)` keyed off the dapp-kit-selected network, so a
  runtime `switchNetwork` flips service ids in lockstep with rpc/packages.

Sequencing: lands after the core multi-network (commits 1–5); commit 4's strict type should narrow
`values` from the start (or a follow-up tightens it). Service bucket shape change (commit 8) is
consumer-visible (`deepbook.pools` → `deepbook.forNetwork(net).pools`).

## autoConnect (#2, deferred): currently `import.meta.env.DEV`. Gating to tests-only needs a
test-only flag injected by the devstack Vite plugin in e2e — only if the owner asks.
