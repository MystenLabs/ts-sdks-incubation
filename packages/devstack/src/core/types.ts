// Devstack core types. Source of truth for the runtime contract; the
// design doc at docs/devstack-design.md narrates the rationale.

import type { Signer } from '@mysten/sui/cryptography';

// ─── Network targets ──────────────────────────────────────────────────────

export type Network = 'localnet' | 'testnet' | 'mainnet';

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
 *
 * The empty `{}` form (every example's default) means "use rule 3 on
 * localnet, fail on live nets" — the most common case. Apps don't need
 * to fill any slots until they actually deploy live.
 */
export interface AccountSpec {
	default?: Signer | AccountFactory;
	localnet?: Signer | AccountFactory;
	testnet?: Signer | AccountFactory;
	mainnet?: Signer | AccountFactory;
}

/** Top-level `accounts:` shape on `DevstackConfig`. Two forms — pick by
 * what you need:
 *
 *   - `string[]` — names only. Equivalent to `Object.fromEntries(names
 *     .map((n) => [n, {}]))`. Localnet generates a per-stack keypair;
 *     live-net deploys throw with a clear message until the user
 *     populates a slot.
 *   - `Record<string, AccountSpec>` — per-account map with optional
 *     per-network slots. Use this when you need a non-default factory
 *     for any network (typical for live-net deploys).
 *
 * The string-array form covers every example app today. */
export type AccountsConfig = readonly string[] | Record<string, AccountSpec>;

/**
 * Per-action accounts handle. Generic over the union of declared
 * account names so app authors get autocomplete on `ctx.accounts.get`
 * inside `run:`/`build:` callbacks of the action factories that thread
 * the union through (`runTransaction({signer})` carries `TSigner` from
 * its own field; `seed({runsAs})` similarly).
 *
 * `get(name)` and `has(name)` are typed against the declared union —
 * a stray `ctx.accounts.get('alic')` against `accounts: ['alice']`
 * surfaces at compile time. `names()` returns the typed union as an
 * array. Plugin code that needs to look up arbitrary account names
 * (no statically-knowable union) keeps the default `TAccounts =
 * string` and works as before. The runtime always materializes a
 * loose `AccountsContext<string>` and the action factories cast at
 * the public boundary.
 */
export interface AccountsContext<TAccounts extends string = string> {
	get(name: TAccounts): Signer;
	/**
	 * Probe — returns false on miss rather than throwing. Keeps the loose
	 * `(string & {})` arm so callers can ask "is this account registered
	 * yet?" without a typed union (mirrors `RegistryQuery.find`'s probe
	 * posture: both return a falsy value on miss).
	 */
	has(name: TAccounts | (string & {})): boolean;
	names(): TAccounts[];
}

/**
 * Extract the union of declared account names from a `DevstackConfigInput['accounts']`
 * value. Supports both the array form (`['alice', 'bob']`) and the
 * record form (`{ alice: {}, bob: {} }`). The `extends string` filter
 * collapses non-string entries (defensive — `accounts:` shouldn't carry
 * them, but TS infers `keyof Record<...>` as `string | number | symbol`
 * by default).
 */
export type AccountNames<TAccounts> =
	TAccounts extends ReadonlyArray<infer N>
		? N extends string
			? N
			: never
		: TAccounts extends Record<infer K, AccountSpec>
			? K extends string
				? K
				: never
			: never;

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
 * Capabilities + registry-rehydrate hook the action provides.
 *
 * The `registry` hook is idempotent — runs once per cycle on cold runs
 * AND on subsequent warm-path skips. Plugins typically share it with
 * `run` to keep the registration logic in one place.
 */
export interface Provides<TCtx extends ActionRunContext = ActionRunContext> {
	capabilities?: string[];
	registry?: (ctx: TCtx) => Promise<void> | void;
}

/**
 * Authoritative reconciler lifecycle states: `idle`, `queued`,
 * `running`, `ok`, `failed`, `skipped`. Two transient UI markers, set
 * outside the reconciler and cleared by the next authoritative
 * `update()`:
 * - `stale` — file watcher saw an input drift; the action will rerun.
 * - `dirty` — Emit's `dependsOnKind` matched a freshly-dirty kind;
 *   cascade pending.
 *
 * `ok` is the universal "settled successfully" state — for a Build it
 * means the image is built, for Publish it means the package is on
 * chain, for Service / HostProcess it means the runtime is up and
 * passing health probes. Display layers (`runtime/renderers/
 * status-label.ts`) translate `ok` to a type-specific verb (`built`,
 * `published`, `ready`, …) so users see prose that matches the action.
 */
export type ActionStatus =
	| 'idle'
	| 'queued'
	| 'running'
	| 'ok'
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
 * Container-layer capture (`commit`) plus host-fs capture under
 * `<stackDir>` covers every plugin's state today. If a future plugin
 * has state outside both seams (e.g. a host-side keystore in
 * `~/.config/`), it should write into `<stackDir>` instead so the
 * implicit host-fs sweep picks it up — that keeps the snapshot model
 * uniform and avoids action-specific capture callbacks the orchestrator
 * has to thread through the bundle.
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
}

interface ActionBase<TCtx extends ActionRunContext, TInputs = unknown, TResult = unknown> {
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
	 * Capabilities for cross-action ordering use `<cap>:before` queries
	 * in `needs:`. They MUST be namespaced with the providing plugin's
	 * name (`<plugin>.<cap>`); un-namespaced capabilities throw at
	 * expansion time. */
	provides?: Provides<TCtx>;
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
	/** Snapshot capture metadata. Set by the `containerService()` factory
	 * from its `snapshot` option field. Read by the snapshot orchestrator
	 * via container labels (`containerService` serializes this into
	 * `devstack.snapshot.*` labels at `docker run` time). Plugin authors
	 * should declare this in the factory call, not stamp it on the action
	 * manually. The plain `service()` and `hostProcess()` factories don't
	 * accept `snapshot:` because they don't run docker containers — there's
	 * no committable layer for the snapshot orchestrator to capture. */
	snapshotMeta?: SnapshotMeta;
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
	/** Plugin that owns this action. Auto-derived from `Plugin.name` by
	 * `expandPluginActions()` — plugin authors don't set this, and the
	 * field is overwritten on expansion if they do. App-level setup
	 * actions synthesized from inline `use:[...]` entries
	 * (`publishMove`, `seed`, `runTransaction`, …) carry the synthetic
	 * plugin name `<app>-setup` (e.g. `'wallet-setup'`,
	 * `'token-studio-setup'`). Used by the supervisor's status renderer
	 * for grouping (one section header per plugin) and per-line log
	 * coloring. */
	plugin?: string;
	run?: (ctx: TCtx) => Promise<TResult>;
	getStatus?: (ctx: TCtx) => Promise<{ ok: boolean; detail?: string }>;
	/**
	 * Stable token representing what this action produced. The reconciler
	 * captures it after every successful run / skip, persists it alongside
	 * `lastInputHash`, and folds the `identity` of every upstream action
	 * named in `needs:` into the downstream's input hash. Result: when an
	 * upstream's identity changes, every downstream cascades-re-runs
	 * automatically. No plugin author has to track "did upstream change
	 * its outputs since I last ran?" by hand.
	 *
	 * Examples:
	 *   - `sui.localnet`: `chainId` from RPC. Chain regenesis → identity
	 *     flips → walrus.deploy / accounts.fund / publishes / etc. all
	 *     cascade.
	 *   - `walrus.deploy`: hash of the deploy file (its parsed package +
	 *     object IDs). Deploy re-runs → walrus.node-* cascade →
	 *     `containerService` recreates them with fresh writable layers.
	 *   - `publish`: registered `packageId`. Republish → seal.register /
	 *     downstream tx-builders cascade.
	 *
	 * Built-in factories supply a sensible default where they can
	 * (`publish` → `packages.find(name).packageId`); explicit override
	 * is for things only the author can compute (chainId via RPC, file
	 * content hash). Returning `undefined` means "no cascade signal" —
	 * use when downstream genuinely doesn't depend on identity drift,
	 * not as a placeholder.
	 */
	identity?: (ctx: TCtx) => Promise<string | undefined>;
}

export interface BuildAction<TInputs = unknown, TResult = unknown> extends ActionBase<
	ActionRunContext,
	TInputs,
	TResult
> {
	type: 'Build';
}

export interface ServiceAction<TInputs = unknown, TResult = unknown> extends ActionBase<
	LocalnetActionRunContext,
	TInputs,
	TResult
> {
	type: 'Service';
}

/**
 * In-process service whose lifecycle is bound to the supervisor process —
 * Node `http.Server` listeners (wallet-app), spawned child processes
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
	LocalnetActionRunContext,
	TInputs,
	TResult
> {
	type: 'HostProcess';
}

export interface PublishAction<TInputs = unknown, TResult = unknown> extends ActionBase<
	ActionRunContext,
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
	ActionRunContext,
	TInputs,
	TResult
> {
	type: 'Register';
}

export interface SeedAction<TInputs = unknown, TResult = unknown> extends ActionBase<
	ActionRunContext,
	TInputs,
	TResult
> {
	type: 'Seed';
}

export interface EmitAction<TInputs = unknown, TResult = unknown> extends ActionBase<
	ActionRunContext,
	TInputs,
	TResult
> {
	type: 'Emit';
	/**
	 * Registry kinds whose dirty bit re-fires this Emit. Accepts core kind
	 * names (`'packages'`, `'accounts'`, `'services'`) or namespaced
	 * (`'walrus.nodes'`, `'arena.sharedObjects'`).
	 *
	 * The literal `'*'` is a wildcard meaning "any dirty kind". Use it
	 * when the Emit consumes the full registry snapshot and can't
	 * enumerate the relevant kinds at action-construction time — the
	 * codegen plugin's typed-manifest emit is the canonical case, since
	 * plugin-namespaced kinds (e.g. `walrus.nodes`, `seal.keyServer`)
	 * aren't enumerable until those plugins have run.
	 *
	 * Mixing `'*'` with other entries is allowed but redundant: the
	 * wildcard subsumes them. `consumeDirty` handles wildcard by
	 * flushing the entire dirty set.
	 */
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
export interface VerifyAction<TInputs = unknown> extends ActionBase<ActionRunContext, TInputs, void> {
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
 *   - `applyFilter` — universal one-shot filter. Localnet runs every
 *     action type; live nets skip Service + HostProcess (no docker
 *     daemon assumed) but keep Build, Publish, Register, Seed
 *     (network-gated), Emit, Verify.
 *   - `applyTestSetupFilter` — Playwright globalSetup variant. Runs
 *     Service (containers detach from the test process) but skips
 *     HostProcess (vite / wallet-app would die when globalSetup
 *     returns).
 *   - `emitOnlyFilter` — only Emit actions; used by `devstack codegen`.
 */
export type ActionFilter = (action: Action, target: ResolvedTarget) => boolean;

// ─── Plugins ──────────────────────────────────────────────────────────────

/**
 * `TProvides` is a string literal union of every action name this plugin
 * contributes (post-namespace-expansion: `'<plugin>.<action>'`). Used by
 * `defineDevstackConfig` to type-check `needs:` references against the
 * plugins actually present in the use array. Plugin factories declare it
 * in their return-type annotation — e.g.
 * `function sui(): Plugin<'sui.localnet' | 'sui.faucet'>`. Defaults to
 * `string` when unannotated so untyped Plugin returns still work.
 *
 * The `__provides` field is type-only — it carries the union forward
 * through inference and is never set at runtime.
 */
export interface Plugin<TProvides extends string = string> {
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
	 * a plugin or editing a `use:` setup action invalidates cached
	 * snapshots automatically. Plugin authors construct it from their
	 * options bag; the runtime treats the value as opaque + JSON-
	 * stringifies it via `stableHash`. */
	inputs?: unknown;
	actions: () => Action[];
	/**
	 * Optional runtime list of fully-qualified action names this plugin
	 * provides — mirrors the `TProvides` type union when the plugin's
	 * action names are statically enumerable. When set, `expandPluginActions`
	 * cross-checks both directions: every literal in `provides` must
	 * appear in the actions returned by `actions()`, and every returned
	 * action's FQN must appear in `provides`. Catches typos like a
	 * declared `'sui.servic'` against a returned `'sui.service'` at
	 * config-load time.
	 *
	 * Plugins with dynamic action sets (e.g. `walrus.node-${number}` for
	 * a configurable committee size) leave this undefined — the type
	 * union is template-literal and isn't a finite set. Static plugins
	 * (sui, accounts, codegen, frontend, wallet-app, seal) set it.
	 */
	provides?: readonly string[];
	/** Type-only phantom: never set at runtime. See doc on `TProvides`. */
	readonly __provides?: TProvides;
}

// ─── Registry kinds (core) ────────────────────────────────────────────────

export interface Token {
	name: string;
	type: string;
	decimals: number;
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
	/** Action that registered this package — auto-stamped by the
	 * reconciler's per-action registry proxy. The TUI groups registry
	 * entries by `providedBy` so each row shows its own outputs (the
	 * Publish action's row shows the resulting packageId; sui.localnet
	 * shows the rpc/faucet URLs, etc.). */
	providedBy?: string;
}

export interface Account {
	name: string;
	address: string;
	role?: string;
	funded?: boolean;
	/** Action that registered this account — auto-stamped by the
	 * reconciler's per-action registry proxy. */
	providedBy?: string;
}

export interface Service {
	name: string;
	kind: string;
	url: string;
	port: number;
	endpointLabel?: string;
	/** Action that registered this service. Stamped automatically by the
	 * reconciler's per-action ctx wrapper — plugin authors don't set
	 * this. The supervisor groups services by `providedBy` to build the
	 * status renderer's per-row endpoint list. */
	providedBy?: string;
}

/**
 * Typed query over a registry kind. `TName` is the literal-string union
 * of names known statically — for `packages` it's the union extracted
 * from sibling `publishMove({ name })` declarations (typically the
 * action's own `needs:` set).
 *
 * `find` / `require` / `unregister` all accept the loose `(string &
 * {})` arm so plugin code that lacks a statically-knowable union can
 * still reach into the registry without casting. Callers with a typed
 * union see the union members in autocomplete; the literal arm catches
 * typos at compile time when the caller picks a name from that union.
 * `register(item)` is typed-only via the item's `name` field — if you
 * want to register an arbitrary string, type the item accordingly.
 *
 * Defaults to `string` so existing call sites and built-in plugin
 * code compile without changes.
 */
export interface RegistryQuery<T, TName extends string = string> {
	list(): T[];
	find(name: TName | (string & {})): T | undefined;
	require(name: TName | (string & {})): T;
	register(item: T): void;
	/** Remove the entry with this name. Returns true if an entry was
	 * removed, false if there was none. Marks the kind dirty on success
	 * so dependent Emit actions re-fire (e.g. codegen drops a generated
	 * file when its package goes away). */
	unregister(name: TName | (string & {})): boolean;
}

/**
 * In-memory registry surfaced on `ctx.registry`. Generic over `TPackages`
 * (the literal-string union of `publishMove({ name })` and
 * `publish({ registryAs })` declarations in the surrounding `use:[]`)
 * so `ctx.registry.packages.find(...)` and `.require(...)` autocomplete
 * known names + flag typos at compile time.
 *
 * Defaults to `string` so the loose form covers built-in plugin code
 * paths that don't see the surrounding config.
 */
export interface Registry<TPackages extends string = string> {
	readonly packages: RegistryQuery<Package, TPackages>;
	readonly accounts: RegistryQuery<Account>;
	readonly services: RegistryQuery<Service>;
}

// ─── Action runtime context ───────────────────────────────────────────────

export type ShutdownHook = () => Promise<void> | void;

/** Fields common to every action's run context, regardless of network.
 * Generic over `TAccounts` (the typed account-name union from
 * `DevstackConfig.accounts`) and `TPackages` (the typed package-name
 * union from inline `publishMove({ name })` declarations) so callbacks
 * inside `seed`/`runTransaction`/`publishMove`/`registerCoin` get
 * autocomplete on `ctx.accounts.get(...)` and
 * `ctx.registry.packages.find/require(...)`. Defaults to `string`
 * everywhere to keep built-in plugin actions and the legacy authoring
 * surface working without explicit generics. */
interface ActionRunContextBase<
	TAccounts extends string = string,
	TPackages extends string = string,
> {
	appName: string;
	/**
	 * Absolute path to the app's root directory (the dir containing
	 * `devstack.config.ts`). Plugins resolve relative paths against this —
	 * e.g. Move package locations and the per-stack state dir at
	 * `<appDir>/.devstack/stacks/<stack>/`.
	 */
	appDir: string;
	registry: Registry<TPackages>;
	/**
	 * Resolved account directory for this run. Names declared in
	 * `DevstackConfig.accounts` materialize into `Signer`s here; on
	 * localnet, accounts without an explicit factory fall back to
	 * `generatedKeypair()`. Errors from individual factory calls are
	 * captured at resolve time and re-thrown on `get(name)` so the rest
	 * of the action graph keeps running.
	 */
	accounts: AccountsContext<TAccounts>;
	/**
	 * Register a teardown callback to run on supervisor shutdown (SIGINT,
	 * `q` keystroke, or programmatic stop). Only present when the action
	 * runs under `devstack up`'s supervisor; one-shot paths (`devstack apply`,
	 * smoke scripts) leave it undefined. Real Service actions that detach
	 * a container (`docker compose up -d`) generally don't need this — the
	 * containers persist across `up` invocations by design. Hooks are
	 * mainly for in-process children (test fixtures, ad-hoc spawns).
	 */
	onShutdown?: (fn: ShutdownHook) => void;
	/**
	 * Stream a log line into the supervisor's status renderer. Always
	 * present — under the supervisor, the renderer prefixes with the
	 * action name + timestamp and handles the panel-erase-then-redraw
	 * dance so logs interleave cleanly with the status block; under
	 * one-shot CLI paths, the implementation forwards to `process.stdout`.
	 *
	 * Useful for Service actions that spawn long-running child processes
	 * — the `frontend` plugin pipes vite's stdout/stderr through this.
	 */
	appendLog: (line: string) => void;
	/**
	 * The reconciler's computed input hash for this run. Folds in
	 * `inputs` plus the `identity` of every upstream named in `needs:`,
	 * so it captures the full upstream-context this action was invoked
	 * with.
	 *
	 * Plumbed mainly so `containerService` can stamp it onto the
	 * container at create time and compare on the next cycle: matching
	 * hash means upstream is unchanged → resume the existing container
	 * (preserves its writable-layer state — RocksDB, chain data,
	 * generated certs); mismatch means upstream drifted → recreate so
	 * stale state goes with it. Without this, every supervisor restart
	 * blindly recreated stateful containers and lost the data.
	 */
	inputHash: string;
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
export interface LocalnetActionRunContext<
	TAccounts extends string = string,
	TPackages extends string = string,
> extends ActionRunContextBase<TAccounts, TPackages> {
	network: 'localnet';
	stack: string;
	ports: PortAllocator;
}

/** Subset of the `runtime/port-allocator` API exposed to plugin code. */
export interface PortAllocator {
	allocate(req: PortRequest): Promise<number[]>;
}

interface PortRequest {
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
 * `stack` is omitted entirely (not present-but-undefined) so reading
 * `ctx.stack` on the union type is a hard TS error unless the author
 * has narrowed on `ctx.network === 'localnet'` first. Without this
 * carve-out, `ctx.stack` would type as `string | undefined` on the
 * union and a missed narrow would silently produce `undefined` at
 * runtime — typically interpolated into a container name where the
 * resulting string lacks the per-stack disambiguator.
 */
interface LiveNetActionRunContext<
	TAccounts extends string = string,
	TPackages extends string = string,
> extends ActionRunContextBase<TAccounts, TPackages> {
	network: 'testnet' | 'mainnet';
}

/**
 * Discriminated union: every action's run context is either localnet
 * (with `stack` + `ports`) or a live network (without). Build /
 * Service / HostProcess actions are typed against
 * `LocalnetActionRunContext` directly via their `Action.run`
 * signatures, so plugin authors get `ctx.stack` / `ctx.ports` reads
 * without any runtime narrowing.
 *
 * Publish / Register / Seed / Emit / Verify actions are typed against
 * the full union — they may run on either network. `stack` and `ports`
 * are absent on `LiveNetActionRunContext`, so reading either on the
 * union without first narrowing is a TS error. Authors that need
 * `ctx.stack` / `ctx.ports` inside a network-flexible action narrow
 * explicitly:
 *
 *   if (ctx.network !== 'localnet') {
 *     throw new Error('foo: requires localnet');
 *   }
 *   // ctx is now LocalnetActionRunContext — `ctx.stack` / `ctx.ports` are accessible.
 *
 * The recommended alternative is to declare `networks: ['localnet']`
 * on the action factory, which lets the network filter drop the action
 * on live-net cycles before the run callback fires. Most plugin
 * authoring takes that route.
 */
export type ActionRunContext<
	TAccounts extends string = string,
	TPackages extends string = string,
> =
	| LocalnetActionRunContext<TAccounts, TPackages>
	| LiveNetActionRunContext<TAccounts, TPackages>;

// ─── Top-level config ─────────────────────────────────────────────────────

/**
 * The shape `defineDevstackConfig` accepts. `use:` is a flat-or-nested
 * array of `Plugin`s (built-in + custom plugin instances) and `Action`s
 * (setup actions like `publishMove(...)`, `runTransaction(...)`, `seed(...)`).
 *
 * Single items, arrays of items, and mixes are all accepted: the runtime
 * flattens before partitioning. Bare actions are folded into a synthetic
 * `<app>-setup` plugin so cross-action `needs:` references stay stable.
 *
 *   defineDevstackConfig({
 *     app: 'token-studio',
 *     accounts: ['alice', 'bob'],
 *     use: [
 *       sui(),
 *       accounts(),
 *       codegen(),
 *       publishMove({ name: 'managedCoin', path: ..., publisher: 'alice' }),
 *     ],
 *   });
 */
export interface DevstackConfigInput {
	app: string;
	use: ReadonlyArray<Plugin | Action | ReadonlyArray<Plugin | Action>>;
	/**
	 * Named signing identities. Two forms:
	 *
	 *   - `accounts: ['publisher', 'alice', 'bob']` — names only. Each
	 *     gets the empty `{}` spec → localnet generates a per-stack
	 *     keypair; live-net deploys throw until you populate a slot.
	 *   - `accounts: { publisher: { mainnet: cliSigner({...}) }, alice: {} }` —
	 *     per-account map for when you need non-default factories.
	 *
	 * Keys (or array entries) become `ctx.accounts.<name>`. See
	 * `AccountSpec` for the per-network slot semantics.
	 */
	accounts?: AccountsConfig;
	networks?: Partial<Record<Network, string>>;
}

/**
 * Internal post-normalization shape. The runtime (CLIs, supervisor,
 * snapshot, etc.) consumes `plugins:` directly; bare setup actions from
 * `DevstackConfigInput.use` are already folded into the synthetic
 * `<app>-setup` plugin entry.
 */
export interface DevstackConfig {
	app: string;
	plugins: Plugin[];
	accounts?: AccountsConfig;
	networks?: Partial<Record<Network, string>>;
}
