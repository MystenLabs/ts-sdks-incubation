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

## Accounts are NETWORK-AGNOSTIC identities; only FUNDING is per-network — cross-cutting invariant
Key distinction (owner): an account is a keypair/address created WITHOUT any network — one address works
on every network, and the dev wallet is a network-agnostic signer over the set of accounts. What needs a
live network is FUNDING (gas), which needs that network's FAUCET. So accounts + dev wallet are a flat,
network-invariant set; funding is the per-network, faucet-gated part. Handle correctly:
- **`accounts` is network-invariant → hoist to the ENVELOPE level.** `DevstackDeployment.accounts`
  (`name → address`), NOT per-`NetworkDeployment` (commit 2 put it per-network; move it up — accounts
  don't vary by network). Created at stack/wallet runtime (keypair gen needs no network); runtime-
  injected, never committed; `{}` in a pure prod build (no managed identities there).
- **The dev wallet is a network-agnostic signer.** It holds the keypairs and can sign on whatever
  network is selected; whether a tx SUCCEEDS depends on funding (gas) on that network. Injection is
  serve-context (pure prod build ships none).
- **Funding is per-network + faucet-gated.** `NetworkScopedOptions` already carries per-network
  `faucet`/`devWallet`/`autoApproveSigning` (default on except `mainnet`). Funding an account on a
  network requires that network's faucet + opt-in: ON for local + faucet-backed live nets
  (devnet/testnet), OFF for `mainnet` (no faucet/real funds). devstack funds via THAT network's faucet —
  the main new work is funding accounts against a live faucet-backed net (devnet), not just a local node.
  (Open: explicit per-network `accounts`/`fund` toggle vs reuse `faucet` + `account(...)` members?
  Default to reuse.)
- **Strict type (0d.4):** `accounts` is OPTIONAL / excluded from the completeness check (network names
  are knowable; addresses are runtime). A hand-written `deployments/<net>.ts` never supplies accounts.
- **`resolveAccounts()` surface (0b):** reads the envelope-level `accounts` (network-invariant). The
  dev-wallet injection respects the `devWallet`/`faucet` flags for the funded-network UX; `connectAs(alice)`
  signs as alice on the selected network (funded there or not).
- **Prod build (deploy=drop-local):** no dev wallet (serve-only), `accounts: {}` — the real prod path. A
  devnet *test* serve/build with `devWallet` + `faucet` opted-in DOES inject the wallet + fund accounts,
  which is how the capstone drives real txs on devnet.

## Capstone: live-network validation (MANUAL, owner-requested — run after 0d.7 + 0e)
Typecheck/unit-green is necessary but NOT sufficient — a real deploy proves the prod path works.
Build a documented, repeatable harness (script + README; NOT a CI gate — live nets are slow/flaky).
Use the template counter package (devnet has a faucet → free gas: `sui client faucet` / the HTTP
faucet). Verify the running app with agent-browser, not just exit codes.

- **Scenario A — prod build, no local stack.** Publish counter to devnet → `devstack dump-deployment
  --network devnet` writes typed `deployments/devnet.ts` (completeness-checked) → `vite build` with
  `deployments: { devnet }` and NO local stack → serve the built bundle → agent-browser confirms: app
  connects to devnet RPC, reads the REAL package id, and a create/increment tx lands on devnet. Proves
  deploy=drop-local + committed deployment + no spurious loud-fail. ALSO assert the built bundle carries
  NO dev wallet and NO accounts (grep the bundle / no dev-wallet UI on the page).
- **Scenario B — both networks in dev (co-existence + switching).** `devstack up` (localnet live) +
  committed `deployments/devnet.ts` → `pnpm dev` → app lists [localnet, devnet]; agent-browser: default
  localnet works (dev wallet + funded local accounts present, `connectAs(alice)` signs on localnet),
  then `switchNetwork('devnet')` → app reads devnet ids and a tx hits devnet via a real wallet; confirm
  the switch does NOT break when the dev wallet has no devnet accounts. Proves runtime co-existence +
  switching + accounts-are-local-only.
- **Scenario C — per-network services (0e).** Same as B but with an example using deepbook/walrus/seal,
  to prove services resolve the right per-network ids on switch. CAVEAT: walrus/seal/deepbook may not
  be on devnet — run C against whichever live net hosts them (likely testnet); core A/B stay on devnet.

Deliverable: the harness + a short "Deploy to a real network" run log. Owner has authorized the live
publish (devnet/testnet test package; ephemeral, faucet-funded).

## autoConnect (#2, deferred): currently `import.meta.env.DEV`. Gating to tests-only needs a
test-only flag injected by the devstack Vite plugin in e2e — only if the owner asks.
