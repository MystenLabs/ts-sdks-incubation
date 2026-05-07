# Devstack public API surface

> **⚠ STALE — rewrite pending.** This snapshot reflects the API as of the
> design-review pass (commit `0561f09`). Phases 1–8 of the redesign at
> `/Users/michaelhayes/.claude/plans/glittery-honking-nebula.md` have since
> landed (see `notes/friction.md` for the summary). The actual current
> surface differs in ~30 places — `coinTokens`, `mintCoinDistribution`,
> `selectService`/`selectPackage`/`selectAccountMap`, `useDevstackDeployed`,
> `useSignAndExecute`, `Card`/`Field`, `Registry.ns`, `DevstackProvider`,
> `localnetDappKitConfig`/`localnetMvrOverrides`, the `/vite`, `/manifest`,
> `/app-setup`, `/react/ui` subpaths, the `setup:`/`scope:` config fields,
> `seed.liveNetworks`, `Action.scope`, `SetupActionScope`, the `onPublished`
> callback, the wrapper `{ rpcUrl }` shape on `DevstackConfig.networks`, and
> `DevstackConfig.test` are all gone. `defineDevstackConfig` now takes a
> single `use:` array with type-checked `needs:` against the plugin set.
> A re-emission against the post-Phase-8 surface is its own work item;
> read source files directly until then.

A design-review snapshot of every name a downstream consumer (`examples/*`, the
`create-devstack-app` template, an external app) can import from
`@mysten-incubation/devstack`. Implementation detail and rationale-of-internals
are deliberately omitted — the goal here is to read the surface as a contract
and ask "is this the right shape?" without having to chase callees.

Scope: only what's reachable from the package's `exports` map in
`package.json`. Identifiers used internally (e.g. `definePlugin`, raw
`buildImage`/`service`/`hostProcess`/`containerService`/`publish`/`register`,
signer factories like `cliSigner`/`envSigner`/`generatedKeypair`) live in source
files but are NOT re-exported and are therefore out of scope.

## Entry points

The package ships ten import subpaths:

| Subpath                              | Purpose                                                              |
| ------------------------------------ | -------------------------------------------------------------------- |
| `@mysten-incubation/devstack`        | Plugin authoring + app-level setup actions (used in `devstack.config.ts`) |
| `@mysten-incubation/devstack/helpers` | Side helpers usable from setup-action callbacks                     |
| `@mysten-incubation/devstack/manifest` | Pure type-only re-export of `Manifest`                              |
| `@mysten-incubation/devstack/app-setup` | One-call dapp-kit construction for devstack apps                   |
| `@mysten-incubation/devstack/react`  | React adapter (provider, hooks, dapp-kit + walrus config helpers)    |
| `@mysten-incubation/devstack/react/ui` | Two presentation primitives (`Card`, `Field`)                       |
| `@mysten-incubation/devstack/vite`   | Vite plugin: virtual `'virtual:devstack-manifest'` module             |
| `@mysten-incubation/devstack/vitest` | Vitest config builder (config-load surface, zero transitive imports) |
| `@mysten-incubation/devstack/vitest/runtime` | Vitest test-side surface (AccountPool, session helpers)      |
| `@mysten-incubation/devstack/playwright` | Playwright config builder + fixtures + page helpers              |

Plus a CLI binary: `devstack` (subcommands documented under [CLI](#cli)).

---

## `@mysten-incubation/devstack` (main barrel)

The surface seen by `devstack.config.ts`. The barrel intentionally hides the
plugin/action authoring primitives — only the app-author surface is exposed.

### Config entry point

```ts
function defineDevstackConfig(config: DevstackConfig): DevstackConfig
```

Identity helper. Every app's `devstack.config.ts` calls it once.

```ts
interface DevstackConfig {
  app: string;
  plugins: Plugin[];
  accounts?: readonly string[] | Record<string, AccountSpec>;
  networks?: Partial<Record<Network, { rpcUrl?: string }>>;
  test?: { accountPoolSize?: number; fundEachAccount?: bigint };
  setup?: Action[];
}

type Network = 'localnet' | 'testnet' | 'mainnet';

interface AccountSpec {
  default?: Signer | AccountFactory;
  localnet?: Signer | AccountFactory;
  testnet?: Signer | AccountFactory;
  mainnet?: Signer | AccountFactory;
}

type AccountFactory = (ctx: {
  accountName: string;
  appDir: string;
  stack: string;
  network: Network;
  rpcUrl: string;
}) => Promise<Signer> | Signer;
```

`accounts` accepts a `string[]` shorthand (each name gets the empty `{}` spec
→ implicit per-stack `generatedKeypair` on localnet, throw on live nets) OR a
fully-spelled `Record<string, AccountSpec>`. `setup` is a list of pre-built
`Action`s — the synthesized `<app>-setup` plugin appends to `plugins`.

### Setup-action factories

Used inside `setup: [...]`. Each returns a typed `Action` variant.

```ts
function publishMove(opts: {
  name: string;
  needs?: string[];
  provides?: Provides;
  path: string;
  capture?: Record<string, string>;
  publisher?: string;          // default 'publisher'
  registryAs?: string;
  onPublished?: (ctx, result) => Promise<void> | void;
  scope?: SetupActionScope;    // default 'always'
}): PublishAction;

function runTransaction(opts: {
  name: string;
  needs?: string[];
  provides?: Provides;
  signer: string;              // account name from DevstackConfig.accounts
  build: (ctx, tx: Transaction) => void | Promise<void>;
  getStatus?: (ctx) => Promise<{ ok: boolean; detail?: string }>;
  scope?: SetupActionScope;
}): SeedAction;

function seed<T>(opts: {
  name: string;
  needs?: string[];
  provides?: Provides;
  registry?: (ctx) => Promise<void> | void;
  inputs: T;
  liveNetworks?: boolean | Network[];
  runsAs?: string;
  scope?: SetupActionScope;
  run: (ctx) => Promise<void>;
  getStatus?: (ctx) => Promise<{ ok: boolean; detail?: string }>;
  identity?: (ctx) => Promise<string | undefined>;
}): SeedAction<T>;

function verify<T>(opts: {
  name: string;
  needs?: string[];
  provides?: Provides;
  registry?: (ctx) => Promise<void> | void;
  inputs?: T;
  check: (ctx) => Promise<{ ok: boolean; detail?: string }>;
}): VerifyAction<T>;

function mintCoinDistribution(opts: {
  name: string;
  needs?: string[];
  provides?: Provides;
  signer?: string;             // default 'publisher'
  distributions: ReadonlyArray<{
    package: string;
    module: string;
    mintFunction?: string;     // default 'mint'
    distribution: ReadonlyArray<{ recipient: string; amount: bigint }>;
  }>;
  gasBudget?: bigint;          // default 500_000_000n MIST
}): SeedAction;

type SetupActionScope = 'always' | 'localnet-only' | 'test-only';
```

`publishMove` and `runTransaction` are positioned as the 90% sugar; `seed` and
`verify` are the underlying primitives that drop down. `mintCoinDistribution`
is a single, explicitly-named convenience for the recurring "mint and split"
pattern.

### Built-in plugins

Each is a factory returning a `Plugin`. Options bags below show defaults.

```ts
function accounts(opts?: {
  minBalance?: bigint;         // default 50 SUI in MIST
  needs?: string[];            // default ['sui.localnet']
}): Plugin;

function sui(opts?: {
  version?: string;            // default 'devnet-v1.71.0' (SUI_DEFAULT_VERSION)
  rpcPort?: number;            // default 9000  (preferred — port allocator)
  faucetPort?: number;         // default 9123
  graphqlPort?: number;        // default 9125
  image?: string;              // pre-built tag; turns build into existence-probe
  dockerContextDir?: string;
  logLevel?: string;           // default 'info,sui=info,sui_node=info'
  volumes?: string[];          // extra docker -v binds
  epochsToRetain?: number | 'MAX'; // default 2
}): Plugin;

const SUI_DEFAULT_VERSION: string;  // re-exported

function walrus(opts?: {
  version?: string;            // default WALRUS_VERSION
  suiVersion?: string;         // default SUI_DEFAULT_VERSION
  nodeHostPortBase?: number;   // default 19185
  epochDuration?: string;      // default '24h'
  committeeSize?: number;      // default 4
  shards?: number;             // default 100
  gc?: boolean;                // default false
}): Plugin;

function seal(opts?: {
  version?: string;
  port?: number;               // default 2024
  keyServerName?: string;      // default 'devstack-local'
  master?: { masterKey: string; publicKey: string };
  publisher?: string;          // default 'publisher'
}): Plugin;

function deepbook(opts?: {
  rev?: string;                // default 'v7.0.0'
  admin?: string;              // default 'publisher'
  pools?: ReadonlyArray<DeepbookPoolSpec>;
  poolNeeds?: string[];
  marketMakers?: ReadonlyArray<DeepbookMarketMakerSpec>;
}): Plugin;

function imports(opts: {
  packages: ImportSpec[];      // discriminated union of GitImportSpec | LocalImportSpec
}): Plugin;

function codegen(opts?: {
  output?: string;             // default 'src/generated/sui'
  mvrName?: (pkgName: string) => string;
}): Plugin;

function frontend(opts?: {
  port?: number;               // default 5173
  command?: string[];          // default ['pnpm', 'exec', 'vite']
  appendPort?: boolean;        // default true
  cwd?: string;
  needs?: string[];            // default ['codegen.generate']
}): Plugin;

function walletServer(opts?: {
  port?: number;               // default 9420
  publicOrigin?: string;
  needs?: string[];            // default ['accounts.fund']
  host?: string;               // default '127.0.0.1'
  allowedOrigins?: string[];
}): Plugin;
```

Notes:
- Every plugin is a parameterless-callable function (no required args except
  `imports`). The empty-options ergonomics matter: the README pitch is "drop
  `sui()` into `plugins:` and you have a chain."
- `DeepbookPoolSpec`, `DeepbookMarketMakerSpec`, `ImportSpec` are NOT exported
  by name — they only appear as parameter types of these factories. App code
  passes inline object literals.
- Names in the action-graph: each plugin owns the namespace `<plugin-name>`
  (e.g. `sui.localnet`, `accounts.fund`, `codegen.generate`, `walrus.deploy`,
  `walrus.node-0`..`node-3`, `walrus.register`, `seal.build`, `seal.publish`,
  `seal.register`, `seal.key-server`, `frontend.dev-server`, `wallet-server.register`,
  `wallet-server.serve`, `imports.<name>`, `deepbook.publish`, `deepbook.pools`,
  `deepbook.market-maker.<name>`).

### Registry types and helpers

```ts
function defineRegistryKind<T extends { name: string }>(
  dottedKey: `${string}.${string}`,
): (registry: Registry) => RegistryQuery<T>;

const coinTokens: (registry: Registry) => RegistryQuery<Token>;

interface Registry {
  readonly packages: RegistryQuery<Package>;
  readonly accounts: RegistryQuery<Account>;
  readonly services: RegistryQuery<Service>;
  ns<T>(name: string): T;       // proxy: any string property access auto-creates a RegistryQuery
}

interface RegistryQuery<T> {
  list(): T[];
  find(name: string): T | undefined;
  require(name: string): T;
  register(item: T): void;
  unregister(name: string): boolean;
}

interface Package {
  name: string;
  packageId: string;
  captured: Record<string, string>;
  deps?: Record<string, string>;
  sourceDigest?: string;
  chainId?: string;
  network: Network;
  path?: string;
  mvrPlaceholder?: string;
  providedBy?: string;
}

interface Account { name: string; address: string; role?: string; funded?: boolean; providedBy?: string }
interface Service { name: string; kind: string; url: string; port: number; endpointLabel?: string; providedBy?: string }
interface Token   { name: string; type: string; treasuryCapId?: string; decimals: number; metadataId?: string; faucet?: bigint }
```

App code that reads the live runtime registry (rare — only in custom setup
actions) goes through `ctx.registry`. App code that reads the *serialized*
registry (the common case — codegen-emitted manifest) goes through the
`Manifest` accessors below.

### Manifest helpers (read-side)

```ts
type Manifest = import('./runtime/manifest-types.js').Manifest;

function selectService(manifest: Manifest, name: string): Service | undefined;
function selectPackage(manifest: Manifest, name: string): Package | undefined;
function selectAccountMap(manifest: Manifest): Record<string, string>;

function defineManifestKind<T extends { name: string }>(
  dottedKey: `${string}.${string}`,
): (manifest: Manifest) => T[];
```

`selectService` / `selectPackage` / `selectAccountMap` cover the core kinds.
`defineManifestKind` is the read-side mirror of `defineRegistryKind` for
plugin-namespaced kinds.

### Cross-cutting: `Action`, `Plugin`, `ActionRunContext`

These are the types every setup-action callback signature touches. Apps
encounter them through `ctx: ActionRunContext` arguments rather than building
their own actions, but the shape is the contract.

```ts
type ActionType = 'Build' | 'Service' | 'HostProcess' | 'Publish'
                | 'Register' | 'Seed' | 'Emit' | 'Verify';

interface Action /* discriminated union, one variant per ActionType */ {
  name: string;                // FQN: '<plugin>.<suffix>' after expansion
  type: ActionType;
  needs?: string[];            // bare → local; dotted → cross-plugin; '<cap>:before' → capability query
  provides?: Provides;
  inputs?: unknown;
  networks?: Network[];
  watches?: string[];
  snapshotMeta?: SnapshotMeta;
  scope?: SetupActionScope;    // app-level setup actions only
  runsAs?: string;
  plugin?: string;             // auto-stamped — author should not set
  run?: (ctx: ActionRunContext) => Promise<unknown>;
  getStatus?: (ctx: ActionRunContext) => Promise<{ ok: boolean; detail?: string }>;
  identity?: (ctx: ActionRunContext) => Promise<string | undefined>;
  // plus type-discriminated extras:
  //   PublishAction:  path: string
  //   SeedAction:     liveNetworks?: boolean | Network[]
  //   EmitAction:     dependsOnKind?: string[]
  //   VerifyAction:   getStatus required; run?: undefined
}

interface Provides {
  capabilities?: string[];     // must be '<plugin>.<cap>'
  registry?: (ctx: ActionRunContext) => Promise<void> | void;
}

interface SnapshotMeta {
  commit?: boolean;            // Service default true; HostProcess default false
  quiesce?: 'pause' | 'stop' | 'none';   // default 'stop'
}

interface Plugin {
  name: string;
  description?: string;
  version?: string;
  inputs?: unknown;            // folded into snapshot id
  actions: () => Action[];
}

type ActionRunContext = LocalnetActionRunContext | LiveNetActionRunContext;

interface ActionRunContextBase {
  appName: string;
  appDir: string;
  registry: Registry;
  accounts: { get(name: string): Signer; has(name: string): boolean; names(): string[] };
  onShutdown?: (fn: () => Promise<void> | void) => void;
  appendLog?: (line: string) => void;
  inputHash: string;
}

interface LocalnetActionRunContext extends ActionRunContextBase {
  network: 'localnet';
  stack: string;
  ports: { allocate(req: { slot: string; preferred?: number; count?: number }): Promise<number[]> };
}

interface LiveNetActionRunContext extends ActionRunContextBase {
  network: 'testnet' | 'mainnet';
  stack?: undefined;
}

function requireLocalnetCtx(ctx: ActionRunContext): asserts ctx is LocalnetActionRunContext;
```

**Open question for review:** `Plugin`, `Action`, and `ActionRunContext` are
structurally exported through the manifest and registry types but are NOT
re-exported by name from the main barrel. Authors of new plugins live in
`packages/devstack/src/plugins/...` and import from `core/types.js` directly.
The decision in `src/index.ts` is to add re-exports "when a consumer
materializes." If we expect external plugin authors at any point, the surface
either needs those types or it needs an explicit "no, plugins are first-party
only" stance.

---

## `@mysten-incubation/devstack/helpers`

```ts
function seedSharedObject(opts: {
  client: SuiJsonRpcClient;
  publisher: Signer;
  target: `${string}::${string}::${string}`;
  objectTypeFilter: string;
  buildTx?: (tx: Transaction, target) => void;
  gasBudget?: bigint;
}): Promise<{ objectId: string; objectType: string; digest: string }>;

function createLocalSuiClient(url: string, network?: Network): SuiJsonRpcClient;
```

Two functions only. Used inside custom `seed()` callbacks. Per the
`helpers.ts` comment, more exports get added as consumer demand materializes —
today nothing else has crossed that bar.

---

## `@mysten-incubation/devstack/manifest`

Type-only re-export:

```ts
type Manifest = {
  app: string;
  network: Network;
  emittedAt: string;
  registry: SerializedRegistry;
  actionStates?: Record<string, SerializedActionState>;
};

interface SerializedRegistry {
  packages: Package[];
  accounts: Account[];
  services: Service[];
  [namespace: string]: unknown;     // plugin-namespaced kinds, opaque
}

interface SerializedActionState {
  lastInputHash: string;
  lastRunAt?: number;
  identity?: string;
}
```

The codegen plugin emits a typed `manifest.ts` whose value is annotated
`as Manifest`; this subpath exists so downstream code (the vite plugin, the
React adapter, tests) can import the type without pulling node-fs into their
type graph.

---

## `@mysten-incubation/devstack/app-setup`

One function, intended for the app's `dapp-kit.ts`:

```ts
function createWalletApp(opts: {
  manifest: unknown;
  autoConnect?: boolean;       // default true
  autoApprove?: boolean;       // default true
  mountUI?: boolean;           // default true
  exposeForPlaywright?: boolean; // default: import.meta.env.DEV
}): { dAppKit: DevstackDappKit };

type DevstackDappKit = DAppKit<('localnet' | 'testnet' | 'mainnet')[], SuiGrpcClient>;
```

Wraps `createDAppKit` with the devstack burner-wallet adapter, manifest-derived
network config, MVR overrides, and the Faucet/Packages/Network panels. Lives at
`/app-setup` rather than the main barrel because pulling it in transitively
imports `@mysten/dapp-kit-core` + `@mysten-incubation/dev-wallet` +
`@mysten-incubation/devstack-wallet-panels` — CLI / supervisor consumers don't
need any of that.

---

## `@mysten-incubation/devstack/react`

```ts
function DevstackProvider(props: { manifest: Manifest | null; children: ReactNode }): ReactElement;

function useDevstackDeployed(opts?: { requirePackages?: ReadonlyArray<string> }): boolean;

function useSignAndExecute(opts?: {
  invalidateKeys?: ReadonlyArray<readonly unknown[]>;
}): UseMutationResult<{ digest: string }, Error, Transaction>;

interface DevstackProviderState { manifest: Manifest | null }

// Vanilla dapp-kit-core config builders. Spread into createDAppKit({...}) on localnet;
// drop on live nets.
function localnetDappKitConfig(manifest: unknown, opts?: {
  localnetRpcUrl?: string;
  additionalNetworks?: Network[];
  networks?: Partial<Record<Network, string>>;
  enableBurnerWallet?: boolean;
}): {
  defaultNetwork: 'localnet';
  networks: Network[];
  createClient: (network: Network) => SuiGrpcClient;
  enableBurnerWallet: boolean;
};

function localnetMvrOverrides(manifest: unknown): { packages: Record<string, string> };

// Walrus client config builder. Spread into new WalrusClient({...}).
function localnetWalrusOptions(manifest: unknown, init?: {
  fetch?: typeof globalThis.fetch;
}): {
  packageConfig: { systemObjectId: string; stakingPoolId: string };
  storageNodeClientOptions: { fetch: typeof globalThis.fetch };
};
```

Plus the corresponding type names:
`DevstackProviderProps`, `UseDevstackDeployedOptions`, `UseSignAndExecuteOptions`,
`LocalnetDappKitConfig`, `LocalnetDappKitConfigOptions`, `LocalnetMvrOverrides`,
`LocalnetWalrusOptions`, `LocalnetWalrusOptionsInit`.

Internal export available but not in the public list: `useDevstackContext` is
declared in `provider.tsx` but is not re-exported from `react/index.ts`.

---

## `@mysten-incubation/devstack/react/ui`

```ts
function Card(props: { ... }): JSX.Element;
function Field(props: { ... }): JSX.Element;
```

Two presentational primitives, intentionally minimal. Used by the example
apps' demo UIs. (Detailed prop shapes deliberately not transcribed —
review-flag if this surface should grow or be removed.)

---

## `@mysten-incubation/devstack/vite`

```ts
function devstackVitePlugins(opts?: {
  manifestPath?: string;
}): VitePlugin[];

function devstackManifestPlugin(opts?: {
  manifestPath?: string;
}): VitePlugin;

interface DevstackVitePluginsOptions     { manifestPath?: string }
interface DevstackManifestPluginOptions  { manifestPath?: string }
```

Effects:
- Synthesizes the `'virtual:devstack-manifest'` module so app code does
  `import { manifest } from 'virtual:devstack-manifest'`.
- Watches `<root>/.devstack/active` and the resolved manifest.json so a
  `devstack stack use` flip live-reloads.
- Falls back to a typed-empty manifest before first `devstack up`.

`devstackVitePlugins` is the single-call ergonomic; `devstackManifestPlugin`
is the lower-level form.

---

## `@mysten-incubation/devstack/vitest`

Config-load surface, fully self-contained (no transitive imports — Vitest's
config loader requires this).

```ts
function defineDevstackVitestConfig(opts?: {
  include?: string[];          // default ['src/**/*.{test,spec}.ts?(x)']
  exclude?: string[];          // default ['e2e/**', 'node_modules', 'dist', '.turbo']
  chain?: boolean;             // wires globalSetup + bumps timeouts
  extend?: UserConfig;         // mergeConfig'd onto the resolved defaults
}): UserConfig;
```

## `@mysten-incubation/devstack/vitest/runtime`

Test-side surface, loaded through vite-node:

```ts
class AccountPool {
  constructor(opts: AccountPoolOptions);
  seed(): Promise<void>;
  lease(): Promise<Lease>;
  keypair(index: number): Ed25519Keypair;
}

interface AccountPoolOptions {
  faucetUrl: string;
  rpcUrl: string;
  size?: number;               // default DEFAULT_POOL_SIZE = 10
  mnemonic?: string;           // default DEFAULT_MNEMONIC (public)
  fundEach?: bigint;           // default DEFAULT_FUND_EACH = 5_000_000_000n MIST
  prefund?: boolean;           // default true
}

interface SeedAccount { index: number; keypair: Ed25519Keypair; address: string }
interface Lease       { account: SeedAccount; release: () => void }

const DEFAULT_MNEMONIC: string;
const DEFAULT_POOL_SIZE: 10;
const DEFAULT_FUND_EACH: bigint;

interface DevstackTestContext { /* shape exposed via Vitest inject('devstack') */ }
function getSessionAccountPool(): AccountPool;
```

---

## `@mysten-incubation/devstack/playwright`

```ts
function defineDevstackPlaywrightConfig(opts: {
  port: number;
  command?: string;            // default 'pnpm dev'
  testDir?: string;            // default './e2e'
  extend?: DevstackPlaywrightExtend;
  manageStack?: boolean;
  configPath?: string;
}): Promise<PlaywrightTestConfig>;

// Page helpers
function connectAs(page: Page, label: string): Promise<void>;
function selectAccount(select: Locator, name: string): Promise<void>;
function waitForBalanceUpdate(
  page: Page,
  name: string,
  predicate: (text: string) => boolean,
  opts?: { timeout?: number },
): Promise<void>;

// AccountPool fixture
const test: TestType<DevstackAccountPoolFixtures, ...>;
const expect: Expect;

interface DevstackAccountPoolFixtures {
  pool: AccountPool;            // session-scoped (one per worker)
  account: Lease;               // per-test
}
```

Apps that opt in import `test` and `expect` from this subpath instead of
`@playwright/test`. `connectAs` requires apps to expose their dapp-kit
instance on `globalThis.__devstackDAppKit__` — `createWalletApp` from
`/app-setup` does this automatically under DEV.

---

## CLI

The `devstack` binary (only one command-line tool ships from this package).
Surface boundaries that affect downstream contracts:

```
devstack up [config]                  Long-running supervisor (localnet only)
devstack apply [config] [--target]    Single-cycle reconcile (Build/Publish/Register/Seed/Emit; no Service)
devstack deploy <config> --network    Live-network deploy
devstack codegen [config] [--target]  Re-emit codegen against the prior manifest
devstack down [config]                Stop containers; preserve volumes
devstack reset [config] --yes         Wipe a stack (containers, volumes, host state)
                                      Flags: --stack <n>, --images, --dry-run
devstack stack list|new|use|down|drop Manage named per-app stacks
devstack snapshot save|restore|list|rm|hash
devstack console [config] [--target]  REPL with manifest, client, accounts pre-bound
```

Environment variables that act as part of the contract:

- `DEVSTACK_STACK` — overrides the active stack name.
- `DEVSTACK_MANIFEST_PATH` — overrides the manifest location for the
  Playwright AccountPool fixture.
- `DEVSTACK_POOL_SIZE`, `DEVSTACK_POOL_FUND_EACH`, `DEVSTACK_SKIP_PREFUND` —
  Playwright AccountPool tuning.
- `DEVSTACK_E2E_TEARDOWN=drop` — full wipe in CI mode.
- `DEVSTACK_E2E_CONFIG_PATH` — set internally by
  `defineDevstackPlaywrightConfig({ manageStack: true })`.

Filesystem contract:

- `<appDir>/devstack.config.ts` — the entry point CLI commands look for.
- `<appDir>/.devstack/active` — single-line file naming the active stack.
- `<appDir>/.devstack/stacks/<stack>/manifest.json` — the persisted
  `Manifest`, watched by the vite plugin.
- `<appDir>/.devstack/stacks/<stack>/ports.json` — port-allocator cache.
- `<appDir>/.devstack/stacks/<stack>/.keys/` — generated keypairs (per-stack).

---

## Surface inventory at a glance

| Subpath                | Functions | Classes | Types/Interfaces | Constants |
| ---------------------- | --------- | ------- | ---------------- | --------- |
| (main)                 | 17        | 0       | 1 (`Manifest`)   | 1 (`SUI_DEFAULT_VERSION`) — actually re-exported from `sui` plugin internals |
| `/helpers`             | 2         | 0       | 0                | 0         |
| `/manifest`            | 0         | 0       | 1                | 0         |
| `/app-setup`           | 1         | 0       | 2                | 0         |
| `/react`               | 6         | 0       | ~9               | 0         |
| `/react/ui`            | 2 (cmps)  | 0       | 0                | 0         |
| `/vite`                | 2         | 0       | 2                | 0         |
| `/vitest`              | 1         | 0       | 1                | 0         |
| `/vitest/runtime`      | 1         | 1       | 4                | 3         |
| `/playwright`          | 4 + `test`/`expect` | 0 | 1            | 0         |

(`SUI_DEFAULT_VERSION` is exported from `plugins/sui/index.ts` but NOT re-exported
through the main barrel. It appears in plugin-internal use only — flag for review
if it should be in the public surface or hidden.)

---

## Suggested review focal points

These are the places the surface most invites a "is this the right shape?"
conversation. Listed without recommendations — the goal of this doc is a
neutral basis for the conversation.

1. **Plugin-author surface.** Today the main barrel hides `definePlugin`, the
   raw `buildImage`/`service`/`hostProcess`/`containerService`/`publish`/
   `register` factories, signer factories (`cliSigner`, `envSigner`,
   `generatedKeypair`), and the `Plugin`/`Action`/`ActionRunContext` types. If
   we're committing to "first-party plugins only," that's a posture worth
   documenting on the barrel itself. If external plugin authors are in scope
   even informally, we need to choose which of those names to surface.

2. **Action authoring vs. setup-action authoring.** `seed()` and `verify()`
   appear in the public surface as setup helpers, but they're also the
   underlying primitives plugins use. Consumers reading the docs see a single
   factory name covering two roles. Worth a hard look at whether to split or
   unify the framing.

3. **`ctx.registry.ns<T>(...)` vs. `defineRegistryKind` / `defineManifestKind`.**
   Three ways to access plugin-namespaced kinds (proxy `ns<T>`, runtime accessor,
   manifest accessor). The README narrative is "use `defineRegistryKind`," but
   the proxy form is structurally exposed via `Registry.ns`.

4. **Implicit assumptions about account names.** `'publisher'` is the default
   `signer:`/`admin:`/`publisher:` for `publishMove`, `runTransaction`,
   `mintCoinDistribution`, `deepbook`, `seal`. Apps that don't declare a
   `publisher` account get a runtime error from `ctx.accounts.get('publisher')`
   rather than a typed surface. Reasonable for a thin prototype; flag for
   review on the path to a more typed surface.

5. **`Action`/`ActionRunContext` types reachable via the React provider.**
   `DevstackProviderState.manifest` carries a `Manifest`, which references
   `SerializedRegistry`, which embeds `Account`/`Package`/`Service`. App code
   that imports the React provider therefore transitively sees the entire
   core type graph — a structural decision worth conscious sign-off.

6. **Subpath count.** Ten subpaths is a lot for a "thin" prototype. Some
   (`/manifest`, `/react/ui`) have one or two exports. Worth asking which to
   collapse vs. keep distinct. The `/app-setup` vs. `/react` split has a
   concrete dependency-isolation rationale; others may be vestigial.

7. **Optional peer-dep policy.** Every framework adapter (`react`, `vite`,
   `vitest`, `playwright`) is gated behind an optional peer dep. Apps that
   import the wrong subpath without the peer installed get a module-not-found
   error rather than a typed denial. Consider whether the `package.json`
   `peerDependenciesMeta` story matches the surface story.
