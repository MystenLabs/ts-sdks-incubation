# Devstack public API surface

A snapshot of every name a downstream consumer (`examples/*`, the
`create-devstack-app` template, an external app) can import from
`@mysten-incubation/devstack`. Implementation detail and rationale-of-internals
are deliberately omitted — the goal here is to read the surface as a
contract.

Scope: only what's reachable from the package's `exports` map in
`package.json`. Identifiers used internally (e.g. `definePlugin`, raw
`buildImage`/`service`/`hostProcess`/`containerService`/`publish`/`register`,
signer factories beyond `cliSigner`/`envSigner`) live in source files but
are NOT re-exported and are therefore out of scope.

## Entry points

The package ships six import subpaths plus a CLI binary:

| Subpath                                      | Purpose                                                              |
| -------------------------------------------- | -------------------------------------------------------------------- |
| `@mysten-incubation/devstack`                | Plugin authoring + setup actions (used in `devstack.config.ts`)      |
| `@mysten-incubation/devstack/helpers`        | Side helpers + signer factories used inside setup-action callbacks   |
| `@mysten-incubation/devstack/react`          | React adapter: `createWalletApp` + walrus-client config helper       |
| `@mysten-incubation/devstack/vitest`         | Vitest config builder (config-load surface, no transitive imports)   |
| `@mysten-incubation/devstack/vitest/runtime` | Vitest test-side surface (`AccountPool`, session helpers)            |
| `@mysten-incubation/devstack/playwright`     | Playwright config builder + fixtures + page helpers                  |

Plus a CLI binary: `devstack` (subcommands documented under [CLI](#cli)).

---

## `@mysten-incubation/devstack` (main barrel)

The surface seen by `devstack.config.ts`. The barrel intentionally hides
the plugin/action authoring primitives — only the app-author surface is
exposed.

### Config entry point

```ts
function defineDevstackConfig<const TUse>(input: DevstackConfigInput): DevstackConfig;

interface DevstackConfigInput {
  app: string;
  use: ReadonlyArray<Plugin | Action | ReadonlyArray<Plugin | Action>>;
  accounts?: AccountsConfig;
  networks?: Partial<Record<Network, string>>;
}

type AccountsConfig = readonly string[] | Record<string, AccountSpec>;
interface AccountSpec {
  default?: Signer | AccountFactory;
  localnet?: Signer | AccountFactory;
  testnet?: Signer | AccountFactory;
  mainnet?: Signer | AccountFactory;
}

type Network = 'localnet' | 'testnet' | 'mainnet';
type AccountFactory = (ctx: {
  accountName: string;
  appDir: string;
  stack: string;
  network: Network;
  rpcUrl: string;
}) => Promise<Signer> | Signer;
```

`defineDevstackConfig` is the single entry point. It:

- Flattens the `use:` array (accepts items, arrays of items, mixes).
- Partitions plugins from bare setup actions.
- Synthesizes a `<app>-setup` plugin from the bare actions so cross-action
  `needs:` references stay stable.
- Auto-injects `'accounts.fund'` into `needs:` of any setup action with
  `runsAs` set, when the `accounts` plugin is in `use:`.
- Returns a normalized `DevstackConfig` with `plugins:` pre-populated.

The runtime consumes `config.plugins`; `use:` is the user-facing field
only.

#### Typed `needs:` validation

The function is generic over `TUse` and constrains every dotted
(`'<plugin>.<action>'`) `needs:` reference to actually be provided by a
plugin in the same `use:` array. Unknown references surface as TS errors:

```ts
defineDevstackConfig({
  app: 'spike-bad',
  use: [
    sui(),
    accounts(),
    publishMove({
      name: 'foo',
      path: '/tmp/foo',
      needs: ['sui.acconut'], // typo
    }),
  ],
});
// Error: Type '...' is not assignable to type
//   '"devstack: needs 'sui.acconut' but no plugin in use:[] provides it"'.
```

Unannotated plugins (those returning the default `Plugin<string>`)
contribute `string & {}` to the provides union, which preserves
autocomplete on annotated siblings while accepting their actions
(graceful degradation). 8 of 9 built-in plugins are annotated today
(`imports` is unannotated; its action names are templated by spec name
and would need `<const TPackages>` machinery).

### Setup-action factories

Used inside `use: [...]`. Each returns a typed `Action` variant.

```ts
function publishMove<const TNeeds extends string = never>(opts: {
  name: string;
  needs?: readonly TNeeds[];
  provides?: Provides;
  path: string;
  capture?: Record<string, string>;
  publisher?: string;          // default 'publisher'
  registryAs?: string;
}): PublishAction & { __needs?: TNeeds };

function runTransaction(opts: {
  name: string;
  needs?: string[];
  provides?: Provides;
  signer: string;              // account name from DevstackConfig.accounts
  build: (ctx, tx: Transaction) => void | Promise<void>;
  getStatus?: (ctx) => Promise<{ ok: boolean; detail?: string }>;
}): SeedAction;

function seed<TInputs>(opts: {
  name: string;
  needs?: string[];
  provides?: Provides;
  inputs: TInputs;
  networks?: Network[];        // default ['localnet']
  runsAs?: string;
  run: (ctx) => Promise<void>;
  getStatus?: (ctx) => Promise<{ ok: boolean; detail?: string }>;
  identity?: (ctx) => Promise<string | undefined>;
}): SeedAction<TInputs>;

function registerCoin<const TFrom extends string, const TName extends string = TFrom>(opts: {
  name?: TName;                // defaults to `from`
  from: TFrom;                 // name of an upstream publishMove action
  module: string;
  type: string;
  decimals: number;
  provides?: Provides;
}): SeedAction & { __needs?: TFrom };
```

`publishMove` is the 90% sugar; `seed` + `runTransaction` are the
underlying primitives. `registerCoin` is the typed follow-on for the
common "publish coin → register in `coin.tokens` namespace" pattern
(replaces the deleted `onPublished` callback on `publishMove`).

The `__needs` phantom is the carrier the type validator reads in
`defineDevstackConfig`.

### Built-in plugins

Each is a factory returning a `Plugin<TProvides>`. Options bags below
show defaults.

```ts
function accounts(opts?: {
  minBalance?: bigint;         // default 50 SUI in MIST
  needs?: string[];            // default ['sui.localnet']
}): Plugin<'accounts.fund'>;

function sui(opts?: {
  version?: string;            // default 'devnet-v1.71.0' (SUI_DEFAULT_VERSION)
  rpcPort?: number;            // default 9000  (preferred — port allocator)
  faucetPort?: number;         // default 9123
  graphqlPort?: number;        // default 9125
  image?: string;              // pre-built tag; turns build into existence-probe
  dockerContextDir?: string;
  logLevel?: string;
  volumes?: string[];
  epochsToRetain?: number | 'MAX'; // default 2
}): Plugin<'sui.build' | 'sui.indexer-db' | 'sui.localnet'>;

function walrus(opts?: {
  version?: string;            // default WALRUS_VERSION
  nodeHostPortBase?: number;   // default 19185
  epochDuration?: string;      // default '24h'
  committeeSize?: number;      // default 4
  shards?: number;             // default 100
  gc?: boolean;                // default false
}): Plugin<
  | 'walrus.network' | 'walrus.build' | 'walrus.deploy'
  | 'walrus.proxy'   | 'walrus.register' | 'walrus.seedWal'
  | `walrus.node-${number}`
>;

function seal(opts?: {
  version?: string;
  port?: number;               // default 2024
  keyServerName?: string;      // default 'devstack-local'
  publisher?: string;          // default 'publisher'
}): Plugin<'seal.build' | 'seal.publish' | 'seal.register' | 'seal.key-server'>;

function deepbook(opts?: {
  rev?: string;                // default 'v7.0.0'
  admin?: string;              // default 'publisher'
  pools?: ReadonlyArray<DeepbookPoolSpec>;
  poolNeeds?: string[];
  marketMakers?: ReadonlyArray<DeepbookMarketMakerSpec>;
}): Plugin<
  | 'deepbook.source' | 'deepbook.publish' | 'deepbook.pools'
  | `deepbook.market-maker-${string}`
>;

function imports(opts: {
  packages: ImportSpec[];      // discriminated union of GitImportSpec | LocalImportSpec
  name?: string;               // plugin instance name; default 'imports'
}): Plugin;                    // unannotated — see ImportSpec below

function codegen(opts?: {
  output?: string;             // default 'src/generated/sui'
  mvrName?: (pkgName: string) => string;
}): Plugin<'codegen.generate'>;

function frontend(opts?: {
  port?: number;               // default 5173
  cwd?: string;
  needs?: string[];            // default ['codegen.generate']
}): Plugin<'frontend.dev-server'>;

function walletServer(opts?: {
  port?: number;               // default 9420
  publicOrigin?: string;
  needs?: string[];            // default ['accounts.fund']
  host?: string;               // default '127.0.0.1'
  allowedOrigins?: string[];
}): Plugin<'wallet-server.register' | 'wallet-server.serve'>;
```

Notes:

- Every plugin is a parameterless-callable function (no required args
  except `imports`). Drop `sui()` into `use:` and you have a chain.
- `DeepbookPoolSpec` and `DeepbookMarketMakerSpec` are exported by name
  for inline-spec authoring. `ImportSpec` is NOT exported by name — it's
  a discriminated union of `GitImportSpec | LocalImportSpec` and apps
  pass inline literals.
- Plugin namespaces in the action graph: each plugin owns the namespace
  `<plugin-name>` (e.g. `sui.localnet`, `accounts.fund`, `walrus.deploy`,
  `frontend.dev-server`).

### Registry types and helpers

```ts
function defineRegistryKind<T extends { name: string }>(
  dottedKey: string,
): (registry: Registry) => RegistryQuery<T>;

interface Registry {
  readonly packages: RegistryQuery<Package>;
  readonly accounts: RegistryQuery<Account>;
  readonly services: RegistryQuery<Service>;
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
```

App code that reads the live runtime registry (in `seed`/`runTransaction`/
custom `seed` callbacks) goes through `ctx.registry`. The three core
kinds are accessible directly; plugin-namespaced kinds (`coin.tokens`,
`arena.sharedObjects`, `walrus.nodes`, etc.) go through
`defineRegistryKind`.

### Manifest helpers (read-side)

```ts
type Manifest = {
  app: string;
  network: Network;
  emittedAt: string;
  registry: SerializedRegistry;
  actionStates?: Record<string, SerializedActionState>;
};

function defineManifestKind<T extends { name: string }>(
  dottedKey: string,
): (manifest: Manifest) => T[];
```

The four core kinds (`packages`, `accounts`, `services`) are accessible
directly off `manifest.registry.*`. `defineManifestKind` provides typed
access to plugin-namespaced kinds. (Compared to the previous surface,
`selectService`/`selectPackage`/`selectAccountMap` are gone — apps use
direct array access on the typed manifest.)

### Cross-cutting types

The types every setup-action callback signature touches. Apps encounter
them through `ctx: ActionRunContext` arguments rather than building
their own actions.

```ts
type ActionType = 'Build' | 'Service' | 'HostProcess' | 'Publish'
                | 'Register' | 'Seed' | 'Emit' | 'Verify';

interface Action {
  name: string;                // FQN: '<plugin>.<suffix>' after expansion
  type: ActionType;
  needs?: string[];            // bare → local; dotted → cross-plugin; '<cap>:before' → capability query
  provides?: Provides;
  inputs?: unknown;
  networks?: Network[];        // default for seed: ['localnet']; default elsewhere: all
  watches?: string[];
  snapshotMeta?: SnapshotMeta;
  runsAs?: string;
  run?: (ctx: ActionRunContext) => Promise<unknown>;
  getStatus?: (ctx: ActionRunContext) => Promise<{ ok: boolean; detail?: string }>;
  identity?: (ctx: ActionRunContext) => Promise<string | undefined>;
  // plus type-discriminated extras:
  //   PublishAction:  path: string
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

interface Plugin<TProvides extends string = string> {
  name: string;
  description?: string;
  version?: string;
  inputs?: unknown;
  actions: () => Action[];
  readonly __provides?: TProvides;  // type-only phantom
}

type ActionRunContext = LocalnetActionRunContext | LiveNetActionRunContext;

interface ActionRunContextBase {
  appName: string;
  appDir: string;
  registry: Registry;
  accounts: { get(name: string): Signer; has(name: string): boolean; names(): string[] };
  onShutdown?: (fn: () => Promise<void> | void) => void;
  appendLog: (line: string) => void;  // always present (one-shot defaults to stdout)
  inputHash: string;
}

interface LocalnetActionRunContext extends ActionRunContextBase {
  network: 'localnet';
  stack: string;
  ports: { allocate(req: { slot: string; preferred?: number; count?: number }): Promise<number[]> };
}

interface LiveNetActionRunContext extends ActionRunContextBase {
  network: 'testnet' | 'mainnet';
}

function requireLocalnetCtx(ctx: ActionRunContext): asserts ctx is LocalnetActionRunContext;
```

---

## `@mysten-incubation/devstack/helpers`

Helpers used inside setup-action callbacks + signer factories used in
per-network account slots.

```ts
function createLocalSuiClient(url: string, network?: Network): SuiJsonRpcClient;

function cliSigner(opts: { alias?: string; configPath?: string }): AccountFactory;
function envSigner(opts: { name: string }): AccountFactory;
```

`cliSigner` and `envSigner` are the live-net signing-material factories
apps plug into per-network account slots (e.g.
`accounts: { publisher: { mainnet: cliSigner({ alias: 'release' }) } }`).

---

## `@mysten-incubation/devstack/react`

```ts
function createWalletApp(opts: {
  manifest: unknown;
  autoConnect?: boolean;       // default true
  autoApprove?: boolean;       // default true
  mountUI?: boolean;           // default true
  exposeForPlaywright?: boolean; // default: import.meta.env.DEV
}): { dAppKit: DevstackDappKit };

type DevstackDappKit = DAppKit<('localnet' | 'testnet' | 'mainnet')[], SuiGrpcClient>;

// Walrus client config builder
function localnetWalrusOptions(manifest: unknown, init?: {
  fetch?: typeof globalThis.fetch;
}): {
  packageConfig: { systemObjectId: string; stakingPoolId: string };
  storageNodeClientOptions: { fetch: typeof globalThis.fetch };
};

interface CreateWalletAppOptions  { ... }   // reflects the params above
interface LocalnetWalrusOptions    { ... }
interface LocalnetWalrusOptionsInit { fetch?: typeof globalThis.fetch }
```

Wraps `createDAppKit` with the devstack burner-wallet adapter, manifest-
derived network config, MVR overrides, and the Faucet/Packages/Network
panels. Apps read the manifest from `./generated/manifest.js`
(codegen-emitted) and pass it in.

---

## `@mysten-incubation/devstack/vitest`

Config-load surface, fully self-contained (no transitive imports —
Vitest's config loader requires this).

```ts
function defineDevstackVitestConfig(opts?: {
  include?: string[];          // default ['src/**/*.{test,spec}.ts?(x)']
  exclude?: string[];
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
  size?: number;               // default 10
  mnemonic?: string;           // default DEFAULT_MNEMONIC (public)
  fundEach?: bigint;           // default 5_000_000_000n MIST
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

`connectAs` requires apps to expose their dapp-kit instance on
`globalThis.__devstackDAppKit__` — `createWalletApp` from `/react`
does this automatically under DEV.

---

## CLI

The `devstack` binary. Single source for every action-graph CLI command.

```
devstack up [config]                  Long-running supervisor (localnet only)
devstack apply [config] [--target]    Single-cycle reconcile against the
                                      active stack or a target. Localnet runs
                                      every action type; live nets skip
                                      Service + HostProcess but keep Build /
                                      Publish / Register / Seed (network-
                                      gated) / Emit / Verify.
devstack codegen [config] [--target]  Re-emit codegen against the prior manifest
devstack down [config]                Stop a stack's containers; preserve volumes
                                      Pass --stack <name> to target a specific stack
devstack wipe [config] --yes          Wipe a stack — containers, volumes, host state
                                      Flags: --stack <n>, --images, --dry-run
devstack stack list|new|use           Manage named per-app stacks
                                      (use down/wipe with --stack to stop/delete)
devstack snapshot save|restore|list|rm|id
                                      Capture / restore named snapshots
devstack console [config] [--target]  REPL with manifest, client, accounts pre-bound
```

Environment variables that act as part of the contract:

- `DEVSTACK_STACK` — overrides the active stack name.
- `DEVSTACK_MANIFEST_PATH` — overrides the manifest location for the
  Playwright AccountPool fixture.
- `DEVSTACK_POOL_SIZE`, `DEVSTACK_POOL_FUND_EACH`, `DEVSTACK_SKIP_PREFUND` —
  Playwright AccountPool tuning. (These are slated to migrate into
  `defineDevstackPlaywrightConfig` opts; tracked in `notes/friction.md`.)
- `DEVSTACK_E2E_TEARDOWN=drop` — full wipe in CI mode.
- `DEVSTACK_E2E_CONFIG_PATH` — set internally by
  `defineDevstackPlaywrightConfig({ manageStack: true })`.

Filesystem contract:

- `<appDir>/devstack.config.ts` — the entry point CLI commands look for.
- `<appDir>/.devstack/active` — single-line file naming the active stack.
- `<appDir>/.devstack/stacks/<stack>/manifest.json` — the persisted
  `Manifest`.
- `<appDir>/.devstack/stacks/<stack>/ports.json` — port-allocator cache.
- `<appDir>/.devstack/stacks/<stack>/.keys/` — generated keypairs (per-stack).
- `<appDir>/src/generated/manifest.ts` — codegen-emitted typed manifest
  imported by app code as `from './generated/manifest.js'`.

---

## Surface inventory at a glance

| Subpath                | Functions | Classes | Types/Interfaces | Constants |
| ---------------------- | --------- | ------- | ---------------- | --------- |
| (main)                 | 14        | 0       | 5 (`Manifest`, `DevstackConfig`, `DevstackConfigInput`, `Plugin`, `Action`, plus `DeepbookPoolSpec`, `DeepbookMarketMakerSpec`) | 0 |
| `/helpers`             | 3         | 0       | 0                | 0         |
| `/react`               | 2         | 0       | 4                | 0         |
| `/vitest`              | 1         | 0       | 1                | 0         |
| `/vitest/runtime`      | 1         | 1       | 4                | 3         |
| `/playwright`          | 4 + `test`/`expect` | 0 | 1            | 0         |

Compared to the pre-redesign snapshot (commit `0561f09`):

- Subpaths down from 10 → 6.
- Main barrel down from 17 → 13 named exports + types.
- Convenience tier deletions: `mintCoinDistribution`, `coinTokens`
  (public re-export), `seedSharedObject`, `selectService`/`Package`/
  `AccountMap`, `useDevstackDeployed`, `useSignAndExecute`,
  `Card`/`Field`, `localnetDappKitConfig`, `localnetMvrOverrides`,
  `Registry.ns<T>` proxy, `DevstackProvider`, `verify` factory.
- Structural moves: `DevstackConfig.plugins + setup` → single `use:`.
  `onPublished` callback → `registerCoin` follow-on. `seed.liveNetworks`
  → `Action.networks`. `DevstackConfig.networks` flattened.
- Type safety: `Plugin<TProvides>`, typed `needs:` validation in
  `defineDevstackConfig`. Typos surface as TS errors at the callsite.

Deferred work tracked in `notes/friction.md`.
