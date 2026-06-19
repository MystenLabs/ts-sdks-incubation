# Devstack docs + API restructure plan

Status: proposed (2026-06-18). Driver: owner doc review surfaced ~25 issues across docs,
tool API, and templates. A 10-agent grounding pass validated each against source; two design
agents produced concrete target specs for the gating API changes. This plan sequences the work.

Naming (owner-chosen): the resolved per-network runtime config is a **deployment**, not "ids" (it
carries rpc/chainId/faucet/graphql endpoints, accounts, mvrOverrides, values — ids are one field).
Family rename applied throughout: type `NetworkDeployment` (per-network) inside a `DevstackDeployment`
envelope; injected global `__DEVSTACK_DEPLOYMENT__`; on-disk `.devstack/stacks/<s>/deployment.json`;
env `DEVSTACK_DEPLOYMENT_FILE`; verb `devstack dump-deployment` (was `dump-ids`); hand-written prod
files `deployments/<network>.ts`. App-facing object stays `config` (`config.forNetwork`,
`config.networkNames`, `config.defaultNetwork`); `requireId` keeps its name (fetches a package id).
Loader `loadDeployment()` reads the envelope; schema file `id-config.ts` → `deployment.ts`
(`DeploymentSchema`/`NetworkDeploymentSchema`). Snippets below use the new names.

Owner decisions locked:
- **Config/IDs → simplify the runtime.** Drop the per-call `resolve*` layer; typed config
  object over a named, exported `NetworkDeployment` (per-network) inside a `DevstackDeployment`
  envelope, read once, single loud-fail at load.
- **Docs IA → Journey + Reference hybrid.** Services and Testing promoted to top-level.
- **Sequence → tool/API first**, then document the new reality.
- **Dev extras → unify under the deployment pattern.** Emit the typed surface stack-free (tsc-green on a
  clean clone); keep the data (addresses, wallet token) gitignored/runtime-injected; no
  prod/hand-written variant.
- **Multi-network co-existence (NEW).** Local + live (testnet/mainnet) deployments co-exist in one
  build so dapp-kit can switch networks at runtime; "deploy" = the same config with local-mode
  networks filtered out. Achieved at the injected-blob/Vite layer, NOT the stack (a stack stays
  single-network). The generated `NetworkDeployment` type is **strict, app-specific, exhaustive** so
  hand-written production deployments are completeness-checked at compile time. Envelope shape folded
  into 0a now; merge + strict type land in Phase 0d.

## Grounding corrections (things the review disproved — don't act on the original framing)
- "Forking documented nowhere" — it's in `live-networks.mdx`, just buried; needs a dedicated page, not net-new content.
- "dev-only extras is a bad idea / inconsistent with type-check-after-codegen" — the mechanism is
  load-bearing (ephemeral accounts; secret wallet token). The fix is the unification in Phase 0b +
  naming/docs, not removal.
- "dapp-kit set up entirely wrong" — the **template** is clean; the **docs** describe plumbing
  instead of the goal. Phase 2/3 fixes docs; template needs only minor fixes (Phase 4).
- The `resolve` API is **not** over-engineered (resolvers already eval at module-init, not lazily),
  and a strict dev==prod interface already exists (today's unnamed injected blob ≡ the file schema).
  It's unnamed/unexported/undocumented — Phase 0a exposes + renames it (`NetworkDeployment`).

---

## Phase 0 — API redesign (tool first; gates docs)

### 0a. Collapse the resolver layer into a load-once typed config

Target: `config-runtime.ts` exports `NetworkDeployment` + `DevstackDeployment` (named, exported,
hand-checkable), `loadDeployment()` (loud-fail once when `__DEVSTACK_DEPLOYMENT__` absent), and thin
helpers `requireId` / `requireValue<T>` /
`optionalValue<T>` that preserve the all-zero-sentinel scrub per load-bearing field. The five
resolver functions (`resolveId`, `resolveNetwork`, `resolveNetworks`, `resolveActiveNetwork`,
`resolveValue`, `resolveValueOptional`) are removed.

Generated `config.ts` after (`dep` = the active `NetworkDeployment`, i.e. `config.forNetwork(default)`):
```ts
import { loadDeployment, requireId } from './config-runtime.js';
const dep = loadDeployment().forNetwork(loadDeployment().defaultNetwork);
export const config = {
  defaultNetwork: __deployment.defaultNetwork,
  forNetwork:     __deployment.forNetwork,     // multi-network accessor (envelope)
  networkNames:   __deployment.networkNames,
  network:        dep.network,
  networks:       Object.fromEntries(__deployment.networkNames.map((n) => [n, __deployment.forNetwork(n)])),
  mvrOverrides:   { "@local/counter": requireId(dep, "@local/counter") },
  packages:       { counter: { byNetwork: { localnet: requireId(dep, "@local/counter") }, mvr: "@local/counter", packageId: requireId(dep, "@local/counter") } },
} as const;
```
`dapp-kit.ts` stops importing the runtime entirely: `createClient(net) => config.forNetwork(net)`.

Behavioral change is localized:
- `contracts/config-bindings.ts` `staticExprFor`: sugar `id`→`requireId(dep,…)`, `network`→`dep.network`,
  generic→`requireValue<tsType>(dep,…)`.
- `orchestrators/codegen/format.ts`: add an optional `preamble` (renders the `loadDeployment()` reads
  + the runtime import) for buckets that contain any `RawExpr`. Literal-only buckets stay import-free.
- Plugin codegen files (sui/package/coin/seal/walrus/deepbook): **doc-comment updates only.**
- Vite/vitest/playwright injection: only the global name changes (`__DEVSTACK_IDS__` → `__DEVSTACK_DEPLOYMENT__`).

Decisions taken from the design spec: **do not memoize** `loadDeployment` (avoids HMR/two-stack
footgun; the global read is cheap); **ship `requireId`** (restores the per-field loud-fail that bare
indexing would lose). **No `config.activeNetwork`** (reversed during impl): a single "active" entry is
a misnomer once the network is runtime-switchable — app code routes through `config.forNetwork(net)`
keyed off the dapp-kit-selected network so `switchNetwork` stays in sync. The default network's entry
is `config.forNetwork(config.defaultNetwork)`.

**Shape the multi-network envelope NOW (owner-confirmed).** The injected blob is the envelope so we
never re-migrate the generated config + every `dapp-kit.ts` twice:
```ts
__DEVSTACK_DEPLOYMENT__ = { defaultNetwork, networks: { [net]: NetworkDeployment } }
```
`NetworkDeployment` (Phase 0a's named per-network type) is **flattened** — each network's
`rpc`/`chainId`/`faucet`/`graphql` sit alongside its `packages`/`accounts`/`mvrOverrides`/`values`
(no nested networks sub-map). `assembleDeployment`/`dump-deployment`/`writeDeployment` keep producing
one per-network unit each. The generated `config` exposes `config.forNetwork(net)`,
`config.networkNames`, `config.defaultNetwork` (+ `config.activeNetwork` = `forNetwork(defaultNetwork)`).
Initially only `localnet` is populated; Phase 0d adds the merge that fills live networks. dapp-kit's
`createClient(net) => config.forNetwork(net)` makes runtime `switchNetwork` work.

Migration (green at each step): add new API alongside old → add preamble capability (no output
change) → flip `staticExprFor` + enable preamble → regenerate all committed trees + fix the ~6
app-authored `dapp-kit.ts`/`deployment.ts` consumers → remove deprecated resolvers. Final grep must
be clean: `resolveId|resolveNetwork|resolveNetworks|resolveActiveNetwork|resolveValue`.

Full spec: see design transcript (config-runtime simplification). Critical files:
`config-runtime.ts`, `config-bindings.ts`, `format.ts`, `service.ts`, both templates' `config.ts`.

### 0b. Unify dev-only extras into the deployment channel; delete `@devstack-dev`

Key finding: the deployment's `accounts` channel already carries addresses (folded by
`assembleDeployment`), so `generated-extras/accounts.ts` is redundant. Collapse both extras into the
injected deployment and delete the whole `generated-extras` subsystem.

- **accounts**: add `resolveAccounts(): Record<string,string>` to committed `config-runtime.ts`
  (returns `loadDeployment().activeNetwork.accounts ?? {}`). Account plugin decl becomes values-only
  (feeds `assembleDeployment`, emits no file). `AccountBindings.scheme/source` have no consumer → drop
  to `name→address`.
- **dev-wallet**: route runtime connection metadata through the deployment's `values['dev-wallet']`
  channel (`walletUrl`, `network`, `protocolPaths`). Rename the misnamed `'dapp-kit-config'` emitter →
  `'dev-wallet-connection'`. **Secret token decision: keep it in the existing 0600 side-channel
  (`pairing.ts` tokenPath), NOT in `deployment.json`** — the Vite `load` hook runs in Node and reads
  the token file by path; only non-secret fields ride `values`. This preserves the tight file mode.
- **Vite `load` hook**: read `resolveAccounts()` + `optionalValue('dev-wallet',…)` instead of
  importing `@devstack-dev/*`; delete the `existsSync` probes. Prod build still returns `export {};`
  before any of this (unchanged strip).
- **Delete**: `@devstack-dev` alias + option, `extrasDir` plumbing (vite, boot envelope, manifest),
  `emitExtras`/`isExtrasDecl`/`'generated-extras'` OutputLocation, `paths.resolveExtras`.
- **tsconfig**: examples drop `@devstack-dev/*` paths AND the `.devstack/.../generated-extras` `include`
  (this `include` of a per-stack dir is what breaks clean-clone `tsc`). Template already ships
  `@generated`-only — canonical shape all examples converge to.

Side benefit: dev-wallet reconnection on republish now rides the same ids watcher (fixes a latent
staleness bug). Migration: data path (1-3) → alias/tsconfig (4-5) → dead-code cleanup (6), tests
updated per step. Heavy test cluster: `service.test.ts`, `boot.test.ts` (extras flush gate),
`output-location.test.ts`, `vite/index.test.ts` (@devstack-dev tests).

Full spec: see design transcript (dev-extras unification). Critical files: `config-runtime.ts`,
`vite/index.ts`, `plugins/wallet/codegen.ts`, `plugins/account/codegen.ts`, `service.ts`.

### 0c. dapp-kit ergonomics + naming
- Confirm the `config.activeNetwork` + `config.mvrOverrides` handoff is the single documented path.
- Emitter rename done in 0b. Audit remaining "dapp-kit-config"/"dev-only extras" terminology in code
  + comments.

### 0d. Multi-network co-existence + going-to-prod (FULLY BUILT — critical path)

Owner: this is a first-class, fully-supported, fully-documented capability — going to prod is a
critical part of the app story. Built on the 0a envelope; the *stack stays single-network* (the
co-existence lives at the injected-blob / Vite merge layer).

**Strict, app-specific generated deployment type.** Codegen emits `src/generated/deployment.ts`
narrowed to exactly this app's declared packages and network set, so hand-written production
deployments are completeness-checked at compile time:
```ts
export type LiveNetwork = 'testnet' | 'mainnet';                 // the declared non-local networks
export interface NetworkDeployment {
  rpc: string;
  packages: { counter: { id: string } };                        // exhaustive over declared packages
  mvrOverrides: Record<`@local/${string}`, string>;
}
export type ProvidedDeployments = { [N in LiveNetwork]: NetworkDeployment };  // every live network REQUIRED
```
Production deployments authored as **typed TS** against this type (not raw JSON — TS gives
compile-time completeness; JSON only runtime). `devstack dump-deployment --network testnet`
scaffolds/refreshes `deployments/testnet.ts` from a live deploy so devs don't hand-type 0x-strings.
Source location (separate `deployments/*.ts` vs inline in `devstack.config.ts`) is secondary to the
strict type; default to separate typed modules, revisit if the owner prefers inline.

**The merge layer.** The Vite plugin assembles the envelope: live localnet (dev) overlaid on the
project's `ProvidedDeployments`. The `deployments` plugin option is a per-network map (e.g.
`deployments: { testnet: 'deployments/testnet.ts', mainnet: 'deployments/mainnet.ts' }`);
`resolveInjectedDeployment` extended from single-file to map. Validate the assembled envelope against
the strict type at build.

**Deploy = filter local.** A production build drops local-mode networks from the merge → bundle ships
only live networks, no local RPC, no dev-wallet. This is the canonical going-to-prod path.

**dapp-kit becomes truly multi-network.** Template/examples regenerated: `networks: config.networkNames`,
`createClient(net) => config.forNetwork(net)` (keying off the `net` arg, not the active-only
resolvers). `switchNetwork('testnet')` from a local dev server works.

**Loud-fail / completeness:** assembled envelope validated at build; a declared network missing its
ids is a build error (dapp-kit eagerly builds every client, so fail eager). Per-network `objects` and
coin `networks` (today ignored / absent) get wired so the per-network surface is exhaustive.

Key files: `id-config.ts`→`deployment.ts` (schema + strict type emission), `service.ts` (stop
dropping `byNetwork`; the per-network units; `assembleDeployment`),
`orchestrators/codegen/config-runtime.ts` (envelope reader `loadDeployment` + `forNetwork`),
`build-integrations/vite/index.ts` (multi-file `deployments` merge + deploy filter),
`cli/wirings/dump-ids.ts`→`dump-deployment.ts` (emit typed TS per network), `plugins/{package,coin}`
(per-network `objects`/coin networks), template + all example `dapp-kit.ts`.

**Half-wired skeleton to fix or remove:** `byNetwork` is emitted into `config.ts` today but dropped by
`idConfigFromBucket` and unreadable at runtime; per-network `objects` accepted but ignored; coins have
no `networks` field. 0d wires these through end-to-end (no more misleading half-feature).

---

## Phase 1 — codegen/typecheck independence (corrected; was "apply UX")
Owner-asserted invariants (which 0b makes cleanly true): **codegen needs no apply/stack, and
type-check + build need no stack, no apply, and no codegen re-run.** The committed `src/generated`
tree is the entire type surface; ids/data resolve at runtime with loud-fail. 0b's removal of the
`@devstack-dev` alias eliminates the ONE thing that previously needed apply-before-tsc (the
account/dev-wallet extras) — so there is NO "run apply before type-checking" step, and we must not
document one.
- `apply`'s real role: inject live deployment data (real ids) for dev-serve / e2e against a booted
  stack — NOT a build or type-check prerequisite. (Earlier "apply before tsc/CI" framing was wrong.)
- `codegen` stays stack-free + apply-free (needs host `sui` only, for move-summary).
- **Guardrail tests** asserting: (a) `devstack codegen` runs with no stack/apply; (b) a clean clone
  type-checks + `vite build` green with no stack, no apply, no regen (committed tree only); (c) a
  build with no injected deployment compiles but throws `DevstackConfigMissingError` only at runtime.
- Keep `DevstackConfigMissingError` messages genuinely actionable so docs needn't narrate them; drop
  the over-documentation that conflated codegen / apply / build.

---

## Phase 2 — Docs IA restructure (Journey + Reference hybrid)

New sidebar:
```
Get started            (merged index+quickstart: what it does, install, first boot, wire app)
Configure your stack   (sui · accounts · packages · coins & funding)
Services               (Walrus · Seal · DeepBook)        ← promoted to top-level
Codegen & ids          (devstack-specific; links out to Move codegen)
Testing                (unit · e2e · browser)            ← promoted to top-level
Live networks & forking (fork gets its own page/anchor)
Going to production    (hand-written ids, prod build, dapp-kit handoff)
Reference              (CLI · errors · internals)
```
- Merge `index.mdx` + `quickstart.mdx`; intro leads with **what it does** (boot/fund/publish/wire/
  generate), not composition.
- Reframe `local-dev.mdx` → "stack state & outputs"; push manifest/router/projection internals to
  Reference > Internals.
- Drop the `features/` umbrella; redistribute. `dev-server` / `known-packages` land under Configure
  or Reference as appropriate.

---

## Phase 3 — Docs content rewrites

- **Tone sweep** (whole docs): kill defensive over-documentation ("loud and actionable, never a
  silent all-zero id", "MUST surface failure", "fail-closed … never a silent restore") and how-*not*-to
  phrasing ("uses direct coin members, not string records"). Rule: state the positive behavior once;
  use a Guarantees box if a contract needs repeating.
- **Services SDK setup** (biggest gap): each of Walrus/Seal/DeepBook gets a "Connect the SDK" section
  showing import → constructor:
  - Walrus: `new WalrusClient({ packageConfig: walrus.packageConfig, storageNodeUrlScheme: walrus.mode==='local'?'http':'https' })`
  - Seal: `new SealClient({ suiClient, serverConfigs: seal.serverConfigs, verifyKeyServers: false })` (explain why false locally)
  - DeepBook: `suiClient.$extend(deepbookExtension({ packageIds, coins, pools }))` from the bindings
- **Codegen**: cut the phantom-type-parameters re-documentation; link to Move SDK codegen docs. Keep
  only devstack-specific: buckets, aliases, `includePhantomTypeParameters` config, ids injection.
- **Config & deployments** (new page): the `NetworkDeployment` per-network unit + the
  `DevstackDeployment` envelope, the strict app-specific generated deployment type, the loud-fail, and
  the explicit dapp-kit handoff (`config.forNetwork` / `config.networkNames` / `mvrOverrides`).
- **Going to production** (flagship page — owner: critical, must be fully documented): end-to-end
  story — declaring the network set, generating + hand-writing typed `deployments/<network>.ts`
  against the strict type, `dump-deployment` to scaffold them from a live deploy, the multi-network
  envelope, wiring dapp-kit to switch networks, the "deploy = drop local" build, and verifying a prod
  build carries no local/dev-wallet artifacts. This is a first-class supported path, not an appendix.
- **Packages & coins**: explain what they *do* (publish+discover vs verify; per-stack registry;
  funding strategies; managed vs detectable-but-unfundable). New `packages-config.mdx`. Rewrite
  cross-coin funding to explain funding plainly.
- **Testing** (new top-level): three-suite layout (unit/e2e/browser) + run matrix; testing deployed
  packages (DEVSTACK_STACK swap); BCS round-trip unit tests from generated bindings; browser e2e with
  dev-wallet-signed txns (createWalletAdapter / connectAs); cross-link dev-wallet auto-approval.

---

## Phase 4 — Examples & templates

- Fix `--host 0.0.0.0` (docs show 127.0.0.1), document/justify port 5179, replace the unsafe
  `config.networks[config.network]` example in `templates/ts/README.md` with `config.activeNetwork`.
- tsconfig: now simplified by 0b (no `@devstack-dev`); confirm clean-clone `tsc` across all examples.
- Regenerate all committed `src/generated` trees after Phase 0.
- Add a `tests/browser/` Playwright example (connect via `connectAs`, sign a Move call via the wallet
  adapter, assert on-chain result) and a BCS round-trip unit test to the template.
- Note `config.packages.*.packageId` is for introspection; app code uses `mvrOverrides`.

---

## Sequencing summary
Phase 0 (0a → 0b → 0c → 0d) lands the new public surface, deletes the extras subsystem, and builds
the full multi-network + going-to-prod path → Phase 1 polishes `apply` UX → Phases 2–4 (docs IA,
content, examples) document the new reality (incl. the flagship Going-to-production page) and can
parallelize once 0 is merged. Each Phase-0 sub-step keeps the tree green (additive → flip →
regenerate → delete). 0a's envelope shape is a prerequisite for 0d (avoids double-migrating the
generated config + dapp-kit consumers).
