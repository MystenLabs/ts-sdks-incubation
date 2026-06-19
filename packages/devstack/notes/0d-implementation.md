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
3. **Remove the vestigial `byNetwork` half-skeleton (reframed: cleanup, not wiring).** With the
   deployments-file path, per-network package ids come from the injected envelope (live local +
   committed `deployments/*.ts`), so `config.forNetwork(net).packages.*.id` already resolves (commit 2).
   That makes `config.packages.*.byNetwork` and the inline `localPackage({networks})`/`PackageNetworks`
   field (+ its ignored per-network `objects`) DEAD. Remove them: drop the `byNetwork` emission from
   `plugins/package/codegen.ts`, the `networks` option from `LocalPackageOptions`/`KnownPackageOptions`
   (confirm no example uses it first), and the `byNetwork` key from the generated `config.ts` shape.
   ONE clear per-network source = the strict-typed `deployments/<net>.ts`. Regenerate. Update tests.
   Green.
4. **Strict generated type** `src/generated/deployment.ts`: `AppPackages` (exhaustive),
   `AppNetworkDeployment extends NetworkDeployment` (required packages/mvrOverrides), `ProvidedNetwork`
   (declared non-local network union), `ProvidedDeployments = Partial<Record<ProvidedNetwork, …>>`, and
   the literal `NETWORK_NAMES` tuple for D2. tsc-green on clean clone (Partial/empty). Regenerate.
   **Also HOIST `accounts`** from per-`NetworkDeployment` to envelope-level `DevstackDeployment.accounts`
   (network-invariant — see the accounts invariant above); update schema/config-runtime/assembleDeployment/
   merge accordingly. (Funding accounts against a live faucet-backed net like devnet is separate runtime
   work — fold into 0b / the account+faucet plugins, exercised by the capstone.)
5. **Resolver removal (smaller than planned — sugar re-pointing was already done by the 0a flip).**
   The emitted `config.ts`/buckets already use the deployment API; `resolve*()` are now used ONLY by
   `templates/{app,ts}/tests/e2e/counter.test.ts` (`resolveActiveNetwork`). So: migrate those two e2e
   tests → `config.forNetwork(config.defaultNetwork)`, then delete `resolve*()` from
   `CONFIG_RUNTIME_SOURCE` + regenerate the 8 trees. Confirm `idsImportSymbols`/import-symbol logic no
   longer references the removed names. Green.
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

## Local = full dev; live = full prod; dev wallet = serve-time + persists across switch — invariant
Owner model (simplified): **devstack is full-featured locally for dev, and gives full PROD functionality
on live networks** (real ids/RPC, nothing simulated). Accounts are network-agnostic identities; the dev
wallet is a network-agnostic signer.
- **No devstack-powered funding on live networks.** devstack funds accounts on the LOCAL stack (local
  faucet) only. Funding accounts on a live net (devnet/testnet) is MANUAL — done by us during the
  capstone, NOT a devstack feature. (Drops the earlier "fund against a live faucet-backed net" work.)
- **`accounts` is network-invariant → hoist to the ENVELOPE level** (`DevstackDeployment.accounts`,
  `name → address`), not per-`NetworkDeployment` (commit 2 put it per-network; commit 4 moves it up).
  Keypair gen needs no network; runtime-injected, never committed; `{}` in a pure prod build.
- **Dev wallet injection is serve-time + network-agnostic, and PERSISTS across a UI network switch.**
  Injected whenever you run THROUGH devstack with the dev-wallet plugin (Vite serve) — NOT per selected
  network. Switching the dapp-kit network in the UI (localnet → devnet) MUST NOT unmount / unregister it
  (it stays a wallet-standard wallet; only the active client changes), so you can drive a devnet tx with
  it once those accounts are manually funded. A pure prod build (not run through devstack) ships NO dev
  wallet. **Add a test asserting the dev wallet survives `switchNetwork`** (no per-network gate drops
  it). 0b / build-integrations/dapp-kit concern.
- **The dev wallet is just `account providers` + `networks` (name → rpc, + optional faucet); it does
  NOT know live vs local.** At injection devstack hands it the FULL network set the app supports — both
  localnet and the live networks from the deployment envelope (`config.networks`, each with its
  rpc/faucet) — plus the account providers. The wallet signs/operates on whichever network dapp-kit has
  selected; its faucet feature funds the SELECTED network's account (so manual devnet funding can go
  through the wallet rather than `sui client faucet`). Implication: the injection payload becomes
  MULTI-network (today it passes a single `rpcUrl`/`network` — change to the networks map), and the
  dev-wallet package (`dev-wallet/inject` + adapter/server) accepts a networks map + advertises each as
  a wallet-standard chain. 0b + dev-wallet package change.
- **Strict type (0d.4):** `accounts` OPTIONAL / excluded from completeness (names knowable, addresses
  runtime). A hand-written `deployments/<net>.ts` never supplies accounts.
- **`resolveAccounts()` surface (0b):** reads the envelope-level `accounts` (network-invariant).
- **Prod build (deploy=drop-local):** no dev wallet, `accounts: {}` — the real prod path.

## Capstone: live-network validation (MANUAL, owner-requested — run after 0d.7 + 0e)
Typecheck/unit-green is necessary but NOT sufficient — a real deploy proves the prod path works.
Build a documented, repeatable harness (script + README; NOT a CI gate — live nets are slow/flaky).
Use the template counter package (devnet has a faucet → free gas: `sui client faucet` / the HTTP
faucet). Verify the running app with agent-browser, not just exit codes.

- **Scenario A — pure prod build, NOT through devstack.** Publish counter to devnet → `devstack
  dump-deployment --network devnet` writes typed `deployments/devnet.ts` (completeness-checked) → `vite
  build` with `deployments: { devnet }` and NO local stack → serve the built bundle → agent-browser
  confirms: app connects to devnet RPC, reads the REAL package id, and a tx lands on devnet (signed by a
  manually-supplied keypair / external wallet). Proves deploy=drop-local + committed deployment + no
  spurious loud-fail. ALSO assert the built bundle carries NO dev wallet (grep bundle / no dev-wallet UI).
- **Scenario B — both networks in dev, dev wallet drives the devnet tx (co-existence + switching).**
  `devstack up` (localnet live) + committed `deployments/devnet.ts` → `pnpm dev` (through devstack, dev
  wallet plugin on) → app lists [localnet, devnet]; agent-browser: localnet works (dev wallet + local
  funded accounts, `connectAs(alice)`), then `switchNetwork('devnet')` → the dev wallet STAYS mounted
  (does not unregister), app reads devnet ids, and after MANUALLY funding alice on devnet
  (`sui client faucet`) the dev wallet signs a tx that lands on devnet. Proves co-existence + switching +
  dev-wallet-persists-across-switch + the devstack-served live-network path.
- **Scenario C — per-network services (0e).** Same as B but with an example using deepbook/walrus/seal,
  to prove services resolve the right per-network ids on switch. CAVEAT: walrus/seal/deepbook may not
  be on devnet — run C against whichever live net hosts them (likely testnet); core A/B stay on devnet.

Deliverable: the harness + a short "Deploy to a real network" run log. Owner has authorized the live
publish (devnet/testnet test package; ephemeral, faucet-funded).

## autoConnect (#2, deferred): currently `import.meta.env.DEV`. Gating to tests-only needs a
test-only flag injected by the devstack Vite plugin in e2e — only if the owner asks.
