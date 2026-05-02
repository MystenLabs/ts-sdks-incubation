// Devstack core types. Source of truth for the runtime contract; the
// design doc at docs/devstack-design.md narrates the rationale.

import type { Signer } from '@mysten/sui/cryptography';

// ─── Network targets ──────────────────────────────────────────────────────

export type Network = 'localnet' | 'testnet' | 'mainnet';

export interface NetworkConfig {
	rpcUrl?: string;
}

// ─── Accounts ─────────────────────────────────────────────────────────────

export interface AccountFactoryContext {
	accountName: string;
	appDir: string;
	stack: string;
	network: Network;
	/** Best-effort RPC endpoint for the resolved network. Empty string when
	 * the supervisor calls `resolveAccounts` ahead of the sui plugin's
	 * Service action — most factories (cliSigner, envSigner, generatedKeypair)
	 * don't need it. */
	rpcUrl: string;
}

export type AccountFactory = (ctx: AccountFactoryContext) => Promise<Signer> | Signer;

/**
 * Per-network signing material. Each slot accepts a pre-built `Signer`
 * (e.g. `cliSigner({ alias })` or `envSigner({ name })`) or an
 * `AccountFactory` that materializes one at resolve time.
 *
 * Resolution precedence per (account, network):
 *  1. `accountSpec[network]` if set;
 *  2. `accountSpec.default` if set;
 *  3. on localnet, an implicit `generatedKeypair()` factory that
 *     loads-or-creates a per-stack Ed25519 keypair on disk;
 *  4. otherwise, materialization fails and is surfaced lazily on first
 *     `ctx.accounts.get(name)` with the captured factory error.
 */
export interface AccountNetworkSpec {
	default?: Signer | AccountFactory;
	localnet?: Signer | AccountFactory;
	testnet?: Signer | AccountFactory;
	mainnet?: Signer | AccountFactory;
}

/** Either a pre-built `Signer`, an `AccountFactory`, or a per-network map.
 * Bare values are treated as the `default` slot — used for every network. */
export type AccountSpec = AccountNetworkSpec | Signer | AccountFactory;

export interface AccountsContext {
	get(name: string): Signer;
	has(name: string): boolean;
	names(): string[];
}

// ─── Action graph ─────────────────────────────────────────────────────────

export type ActionType =
	| 'Build'
	| 'Service'
	| 'HostProcess'
	| 'Publish'
	| 'Register'
	| 'Seed'
	| 'Emit'
	| 'Verify';

/**
 * Object form of `provides`. Carries capability names plus an optional
 * registry-rehydrate hook the reconciler invokes on warm-path skips so
 * plugins don't have to manually re-register from `getStatus`.
 *
 * The `registry` hook is idempotent — runs once per cycle on cold runs
 * AND on subsequent warm-path skips. Plugins typically share it with
 * `run` to keep the registration logic in one place.
 */
export interface ProvidesObject {
	capabilities?: string[];
	registry?: (ctx: ActionRunContext) => Promise<void> | void;
}

/** Capabilities + registry-rehydrate hook the action provides. */
export type Provides = ProvidesObject;

/** Normalize `provides` to its capability list. */
export function getProvidedCapabilities(provides: Provides | undefined): string[] {
	return provides?.capabilities ?? [];
}

/** Extract the registry-rehydrate hook from `provides`, if any. */
export function getProvidesRegistryHook(
	provides: Provides | undefined,
): ((ctx: ActionRunContext) => Promise<void> | void) | undefined {
	return provides?.registry;
}

/**
 * Authoritative reconciler states: `idle`, `queued`, `running`, `healthy`,
 * `failed`, `skipped`. Two transient UI markers, set outside the reconciler
 * and cleared by the next authoritative `update()`:
 * - `stale` — file watcher saw an input drift; the action will rerun.
 * - `dirty` — Emit's `dependsOnKind` matched a freshly-dirty kind;
 *   cascade pending.
 */
export type ActionStatus =
	| 'idle'
	| 'queued'
	| 'running'
	| 'healthy'
	| 'failed'
	| 'skipped'
	| 'stale'
	| 'dirty';

/**
 * Per-action snapshot capture metadata. Plugins declare this on
 * Service/HostProcess actions to control what `devstack snapshot save`
 * does for their containers; the orchestrator reads it from container
 * labels (set at `docker run` time via `devstackContainerLabels`).
 *
 * Defaults when absent:
 *   - Service: `{ commit: true, quiesce: 'stop' }`
 *   - HostProcess: `{ commit: false, quiesce: 'none' }`
 *
 * The `capture`/`restore` callbacks are reserved for plugin-specific
 * state outside the container's writable layer or `<stackDir>` — most
 * plugins don't need them, since the implicit container-layer + host-fs
 * model covers the typical case.
 */
export interface SnapshotMeta {
	/** Capture this container's writable layer via `docker commit` on
	 * `snapshot save`. Set false for stateless services (seal,
	 * walrus.proxy) that re-derive on every start — saves snapshot disk
	 * + image-store space. Default: true for Service, false for HostProcess. */
	commit?: boolean;
	/** Quiesce strategy before capture.
	 *   - 'pause': cgroup freezer (microseconds; safe for single-writer
	 *     RocksDB like sui localnet)
	 *   - 'stop': graceful SIGTERM with timeout (required for batched-write
	 *     services like walrus storage nodes — flushes pending writes)
	 *   - 'none': skip (stateless / nothing to flush)
	 * Default: 'stop' (universally safe). */
	quiesce?: 'pause' | 'stop' | 'none';
	/** Reserved for plugins with state outside the container layer + host
	 * fs. Returns an opaque blob persisted in the snapshot bundle alongside
	 * the host capture. Most plugins leave this undefined. */
	capture?: (ctx: ActionRunContext) => Promise<unknown>;
	/** Symmetric restore for state captured via `capture`. */
	restore?: (ctx: ActionRunContext, blob: unknown) => Promise<void>;
}

export interface ActionBase<TInputs = unknown, TResult = unknown> {
	name: string;
	type: ActionType;
	needs?: string[];
	/**
	 * Capabilities this action provides + an optional registry-rehydrate
	 * hook (`{ capabilities?, registry? }`). The registry hook fixes the
	 * historical "manually re-register services from `getStatus`"
	 * anti-pattern: when the reconciler skips `run` (warm path), it calls
	 * `provides.registry(ctx)` so registry entries this action provides
	 * are populated in the in-memory registry without re-running.
	 *
	 * Capabilities for cross-action ordering (`:before` / `:after`) MUST
	 * be namespaced with the providing plugin's name (`<plugin>.<cap>`).
	 * Un-namespaced capabilities throw at expansion time. */
	provides?: Provides;
	inputs?: TInputs;
	networks?: Network[];
	/** Extra paths the file watcher should treat as inputs to this
	 * action, in addition to whatever the action shape implies (Publish:
	 * `<path>/Move.toml`, `<path>/sources/**`; Build: dockerfile + ctx).
	 * Paths are resolved against `appDir` and may use glob syntax. Touch
	 * any of them and the action goes `stale` immediately and reruns at
	 * the next cycle. Use for hand-curated configs (GraphQL schemas,
	 * checked-in JSON, generated SDLs) whose change should trigger a
	 * rerun but isn't detectable from the action's own shape. */
	watches?: string[];
	/** Snapshot capture metadata. Set by `containerService()` /
	 * `service()` / `hostProcess()` factories from their `snapshot` option
	 * field. Read by the snapshot orchestrator via container labels (the
	 * factories serialize this into `devstack.snapshot.*` labels at
	 * `docker run` time). Plugin authors should declare this in the
	 * factory call, not stamp it on the action manually. */
	snapshotMeta?: SnapshotMeta;
	/** Setup-action scope. Set by `runTransaction()` / `publishMove()` /
	 * any user-declared action in `DevstackConfig.setup`. The action
	 * filters drop out-of-scope actions before the topo walk:
	 *   - 'always' (default): runs in every stack
	 *   - 'localnet-only': skips on testnet/mainnet
	 *   - 'test-only': runs only when the active stack name starts with 'test'
	 * (Framework-internal plugin actions don't set this; they're scoped via
	 * other mechanisms — `seed.liveNetworks`, `applyFilter`, etc.) */
	scope?: SetupActionScope;
	/** Account name this action signs transactions as. The reconciler
	 * uses this as a soft scheduling constraint: at most one inflight
	 * action per distinct `runsAs` value, so two `publishMove`s with
	 * the same default `'publisher'` don't equivocate on the publisher's
	 * gas object. Actions without `runsAs` are unconstrained.
	 *
	 * Set automatically by the action factories that own the signer
	 * choice (`publish`, `seed` when `runsAs:` is provided,
	 * `runTransaction` from its `signer:`). Plugin authors whose
	 * `run:` callbacks call `ctx.accounts.get(...)` directly should
	 * declare `runsAs:` on the factory call so the reconciler can
	 * serialize them. */
	runsAs?: string;
	run?: (ctx: ActionRunContext) => Promise<TResult>;
	getStatus?: (ctx: ActionRunContext) => Promise<{ ok: boolean; detail?: string }>;
}

/** Scope filter for app-level setup actions declared in `DevstackConfig.setup`. */
export type SetupActionScope = 'always' | 'localnet-only' | 'test-only';

export interface BuildAction<TInputs = unknown, TResult = unknown> extends ActionBase<
	TInputs,
	TResult
> {
	type: 'Build';
}

export interface ServiceAction<TInputs = unknown, TResult = unknown> extends ActionBase<
	TInputs,
	TResult
> {
	type: 'Service';
}

/**
 * In-process service whose lifecycle is bound to the supervisor process —
 * Node `http.Server` listeners (wallet-server), spawned child processes
 * (vite dev-server). Discriminated from `Service` (docker containers
 * detached from the supervisor) so test-setup paths can drop them: a
 * Playwright globalSetup that runs HostProcess actions starts servers
 * that immediately die when globalSetup returns, leaving downstream
 * test logic to race against re-spawned (different-token) instances.
 *
 * Plugin authors get this type by calling `hostProcess()` instead of
 * `containerService()`/`service()`. The runtime contract is identical
 * to `Service` outside of filtering: same shutdown-hook semantics, same
 * getStatus probe expectations, same place in the topo graph.
 */
export interface HostProcessAction<TInputs = unknown, TResult = unknown> extends ActionBase<
	TInputs,
	TResult
> {
	type: 'HostProcess';
}

export interface PublishAction<TInputs = unknown, TResult = unknown> extends ActionBase<
	TInputs,
	TResult
> {
	type: 'Publish';
	/**
	 * Move package source directory (relative to `appDir`). The file
	 * watcher walks `<path>/Move.toml` + `<path>/sources/**`.
	 *
	 * Imported packages whose source lives inside a docker image (the
	 * `imports` plugin's flow, seal's `prepareSource` flow) carry the
	 * literal placeholder string `'<imported>'` here. The file watcher
	 * skips paths that don't exist on the host, so the placeholder is a
	 * no-op for it; codegen also silently skips registry entries with
	 * `path: undefined`. Plugin authors that need a non-on-host path
	 * should follow the same convention.
	 */
	path: string;
}

export interface RegisterAction<TInputs = unknown, TResult = unknown> extends ActionBase<
	TInputs,
	TResult
> {
	type: 'Register';
}

export interface SeedAction<TInputs = unknown, TResult = unknown> extends ActionBase<
	TInputs,
	TResult
> {
	type: 'Seed';
	liveNetworks?: boolean | Network[];
}

export interface EmitAction<TInputs = unknown, TResult = unknown> extends ActionBase<
	TInputs,
	TResult
> {
	type: 'Emit';
	dependsOnKind?: string[];
}

/**
 * Read-only invariant check. The reconciler runs `getStatus` only and fails
 * the cycle on `ok:false`. No `run`. Useful for assertions like "seal
 * key-server is reachable", "walrus storage nodes report healthy" — the
 * Verify is wired downstream of whichever Service it gates and surfaces a
 * loud failure rather than letting downstream actions encounter a silent
 * misconfiguration.
 */
export interface VerifyAction<TInputs = unknown> extends ActionBase<TInputs, void> {
	type: 'Verify';
	getStatus: (ctx: ActionRunContext) => Promise<{ ok: boolean; detail?: string }>;
	run?: undefined;
}

export type Action =
	| BuildAction
	| ServiceAction
	| HostProcessAction
	| PublishAction
	| RegisterAction
	| SeedAction
	| EmitAction
	| VerifyAction;

// ─── CLI target + filters ─────────────────────────────────────────────────

/**
 * Resolved CLI target — the (network, stack, rpcUrl) triple a one-shot
 * cycle runs against. Live-network targets carry the placeholder
 * `DEFAULT_STACK` so the type stays narrow; manifests for testnet/mainnet
 * are still keyed by network only.
 */
export interface ResolvedTarget {
	network: Network;
	stack: string;
	rpcUrl: string;
}

/**
 * Predicate applied during plugin expansion — actions for which it returns
 * `false` are dropped before the topo walk. Built-in filters live in
 * `cli/filters.ts`:
 *   - `deployFilter` — live-net deploy slice (skip Service; gate Seed).
 *   - `applyFilter` — localnet runs all; live nets skip Service+Build.
 *   - `emitOnlyFilter` — only Emit actions; used by `devstack codegen`.
 */
export type ActionFilter = (action: Action, target: ResolvedTarget) => boolean;

// ─── Plugins ──────────────────────────────────────────────────────────────

export interface Plugin {
	name: string;
	/** Optional human-readable description shown in `devstack stack list`
	 * and the renderer's plugin-overview block (when added). */
	description?: string;
	/** Plugin author's semver. Surfaced in diagnostic output so a stale
	 * cached image / wrong-version footgun is easier to triage. Plugin
	 * authors set this manually; not enforced. */
	version?: string;
	/** Stable summary of every structurally-significant input the plugin
	 * accepts — image tag, git rev, port hints, action set, etc. Folded
	 * into the snapshot id (`snapshotIdFromConfig`) so bumping `rev:` on
	 * a plugin or editing a `setup:` action invalidates cached
	 * snapshots automatically. Plugin authors construct it from their
	 * options bag; the runtime treats the value as opaque + JSON-
	 * stringifies it via `stableHash`. */
	inputs?: unknown;
	actions: () => Action[];
}

// ─── Registry kinds (core) ────────────────────────────────────────────────

export interface Token {
	name: string;
	type: string;
	treasuryCapId?: string;
	decimals: number;
	metadataId?: string;
	faucet?: bigint;
}

export interface Package {
	name: string;
	packageId: string;
	captured: Record<string, string>;
	deps?: Record<string, string>;
	sourceDigest?: string;
	/**
	 * Sui chain identifier from the chain that published this package.
	 * The Publish action's source-digest gate compares this against the
	 * live chain on the next cycle — a force-regenesis writes a new
	 * chainId, which busts every cached `sourceDigest` automatically.
	 */
	chainId?: string;
	network: Network;
	/**
	 * Absolute path to the package's source dir on the host (the dir
	 * containing `Move.toml`). Set by Publish actions that build from
	 * local sources; left undefined for imported packages whose source
	 * lives inside a docker clone (e.g. deepbook, seal).
	 *
	 * The codegen plugin reads this — only packages with `path` get
	 * TypeScript bindings generated; pathless entries are silently
	 * skipped.
	 */
	path?: string;
	/**
	 * MVR placeholder string the codegen plugin embedded in this
	 * package's emitted builders (e.g. `@local/connect-four`). Apps
	 * read this off the manifest via `localnetMvrOverrides(manifest)`
	 * to build the SDK's MVR override map; without it the same shape
	 * would have to be recomputed in two places.
	 */
	mvrPlaceholder?: string;
}

export interface Account {
	name: string;
	address: string;
	role?: string;
	funded?: boolean;
}

export interface Service {
	name: string;
	kind: string;
	url: string;
	port: number;
	endpointLabel?: string;
}

export interface RegistryQuery<T> {
	list(): T[];
	find(name: string): T | undefined;
	require(name: string): T;
	register(item: T): void;
	/** Remove the entry with this name. Returns true if an entry was
	 * removed, false if there was none. Marks the kind dirty on success
	 * so dependent Emit actions re-fire (e.g. codegen drops a generated
	 * file when its package goes away). */
	unregister(name: string): boolean;
}

export interface Registry {
	readonly tokens: RegistryQuery<Token>;
	readonly packages: RegistryQuery<Package>;
	readonly accounts: RegistryQuery<Account>;
	readonly services: RegistryQuery<Service>;
	/**
	 * Plugin-namespaced kinds. Consumers narrow with a generic type
	 * argument: `ctx.registry.ns<{ nodes: RegistryQuery<Node> }>('walrus').nodes`.
	 * Get-or-creates the namespace; queries auto-create their kind on first access.
	 *
	 * `T` is unconstrained intentionally — the runtime returns a Proxy that
	 * auto-creates `RegistryQuery` queries on any string property access, so a
	 * tighter constraint (e.g. `Record<string, RegistryQuery<unknown>>`)
	 * would force plugin-author types to carry a redundant index signature
	 * for no enforcement benefit.
	 */
	ns<T>(name: string): T;
	/** True if the named kind (core: 'tokens'; namespaced: 'walrus/blobs') was modified this cycle. */
	isDirty(kindKey: string): boolean;
	/** Returns + clears the dirty set. Reconciler calls between cycles. */
	flushDirty(): Set<string>;
	/**
	 * Removes the listed kinds from the dirty set without clearing others.
	 * Reconciler calls this after each Emit run to record "this Emit has
	 * seen these kinds at their current state." If a later action in the
	 * same cycle re-dirties any of them, the cascade re-fires the Emit.
	 */
	consumeDirty(kinds: string[]): void;
}

// ─── Action runtime context ───────────────────────────────────────────────

export type ShutdownHook = () => Promise<void> | void;

/** Fields common to every action's run context, regardless of network. */
interface ActionRunContextBase {
	appName: string;
	/**
	 * Absolute path to the app's root directory (the dir containing
	 * `devstack.config.ts`). Plugins resolve relative paths against this —
	 * e.g. Move package locations and the per-stack state dir at
	 * `<appDir>/.devstack/stacks/<stack>/`.
	 */
	appDir: string;
	registry: Registry;
	/**
	 * Resolved account directory for this run. Names declared in
	 * `DevstackConfig.accounts` materialize into `Signer`s here; on
	 * localnet, accounts without an explicit factory fall back to
	 * `generatedKeypair()`. Errors from individual factory calls are
	 * captured at resolve time and re-thrown on `get(name)` so the rest
	 * of the action graph keeps running.
	 */
	accounts: AccountsContext;
	/**
	 * Register a teardown callback to run on supervisor shutdown (SIGINT,
	 * `q` keystroke, or programmatic stop). Only present when the action
	 * runs under `devstack up`'s supervisor; one-shot paths (`devstack deploy`,
	 * smoke scripts) leave it undefined. Real Service actions that detach
	 * a container (`docker compose up -d`) generally don't need this — the
	 * containers persist across `up` invocations by design. Hooks are
	 * mainly for in-process children (test fixtures, ad-hoc spawns).
	 */
	onShutdown?: (fn: ShutdownHook) => void;
	/**
	 * Stream a log line into the supervisor's status renderer. The
	 * renderer prefixes with the action name + timestamp and handles
	 * the panel-erase-then-redraw dance so logs interleave cleanly with
	 * the status block. Only present under the supervisor; one-shot
	 * paths leave it undefined.
	 *
	 * Useful for Service actions that spawn long-running child processes
	 * — the `vite()` plugin pipes vite's stdout/stderr through this.
	 */
	appendLog?: (line: string) => void;
}

/**
 * Localnet run context. Carries `stack` because container/network/volume
 * names and host-side state paths all include the stack on localnet. A
 * stack is a per-app named environment (default `'main'`); only one is
 * up at a time per app, but multiple stacks coexist on disk and can be
 * brought up/down independently.
 *
 * `ports` is the per-stack port allocator. Plugins that bind a host port
 * call `await ctx.ports.allocate({ slot: '<plugin>.<name>', preferred: ... })`;
 * the allocator returns a stable port for the slot for the stack's
 * lifetime, persists assignments to `<stackDir>/ports.json`, and falls
 * back to a kernel-chosen port when the preferred slot is taken. This
 * is what lets `main` and `test` stacks of the same app coexist —
 * neither stack hardcodes the same port.
 */
export interface LocalnetActionRunContext extends ActionRunContextBase {
	network: 'localnet';
	stack: string;
	ports: PortAllocator;
}

/** Subset of the `runtime/port-allocator` API exposed to plugin code. */
export interface PortAllocator {
	allocate(req: PortRequest): Promise<number[]>;
}

export interface PortRequest {
	/** Plugin-namespaced slot name (e.g. 'sui.rpc'). Must be stable
	 * across calls — it's the cache key. */
	slot: string;
	/** Preferred port. Used when free; else the kernel picks one. Lets
	 * pinned-port apps keep their numbers. */
	preferred?: number;
	/** Number of contiguous ports to allocate. Default 1. Walrus's
	 * storage-node host port range uses `count: 4`. */
	count?: number;
}

/**
 * Live-network run context (testnet/mainnet). No `stack` — live-network
 * deploys ignore the stack dimension; those manifests are keyed by
 * network only. Plugins that need the stack (container name building,
 * host-side state dirs) must narrow on `ctx.network === 'localnet'`
 * first; if they actually require localnet, throw with a clear message.
 *
 * `stack?: undefined` is explicit so the type narrows correctly on
 * `ctx.network === 'localnet'`: code that reaches `ctx.stack` on a
 * live-network ctx is a type error, not a quiet `'main'` placeholder.
 */
export interface LiveNetActionRunContext extends ActionRunContextBase {
	network: 'testnet' | 'mainnet';
	stack?: undefined;
}

/**
 * Discriminated union: every action's run context is either localnet
 * (with `stack`) or a live network (without). Plugin code that touches
 * `stack` must narrow with `if (ctx.network === 'localnet') { ... }` or
 * call `requireLocalnetCtx(ctx)` to assert at runtime.
 */
export type ActionRunContext = LocalnetActionRunContext | LiveNetActionRunContext;

/**
 * Runtime narrowing helper. Throws with an actionable message when an
 * action that requires localnet (Service / Build / container-touching
 * Publish) is asked to run on testnet/mainnet. After this returns,
 * TypeScript narrows `ctx` to `LocalnetActionRunContext` so reads of
 * `ctx.stack` typecheck.
 */
export function requireLocalnetCtx(ctx: ActionRunContext): asserts ctx is LocalnetActionRunContext {
	if (ctx.network !== 'localnet') {
		throw new Error(
			`requireLocalnetCtx: this action requires localnet but got ${ctx.network}. ` +
				`Live-network targets should filter the action out (see cli/filters.ts) or ` +
				`the action should branch on \`ctx.network\` to handle the live-net case.`,
		);
	}
}

// ─── Top-level config ─────────────────────────────────────────────────────

export interface DevstackConfig {
	app: string;
	plugins: Plugin[];
	/**
	 * Named signing identities. Keys become `ctx.accounts.<name>`; the
	 * resolver materializes a `Signer` per account using the spec's
	 * per-network slot (or `default`), falling back to an implicit
	 * `generatedKeypair()` on localnet. See `AccountSpec` for the
	 * precedence rules.
	 */
	accounts?: Record<string, AccountSpec>;
	networks?: Partial<Record<Network, NetworkConfig>>;
	test?: TestConfig;
	/**
	 * App-level setup actions: Move package publishes, fixture mints,
	 * shared-object seeds. Compiled into a synthetic plugin named
	 * `<app>-setup` and appended to `plugins`. Use the ergonomic factories
	 * `publishMove()` and `runTransaction()` for the common cases — they
	 * forward to `definePublishAction` / `seed` with sensible defaults
	 * (auto getStatus, default signer, marker-file idempotence).
	 *
	 * Per-action `scope` field controls whether the action runs in a
	 * given stack (`'always'` default; `'test-only'` for fixtures only
	 * needed in test stacks; `'localnet-only'` to skip on live nets).
	 */
	setup?: Action[];
}

export interface TestConfig {
	accountPoolSize?: number;
	fundEachAccount?: bigint;
}
