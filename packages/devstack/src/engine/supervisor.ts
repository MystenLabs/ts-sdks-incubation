// defineDevstack — the top-level entry users call in their
// devstack.config.ts. It accepts a stack of tags (each carrying a hidden
// __layer), composes them into one Layer.mergeAll, provides the
// infrastructure (registries, state-store, engine) and platform
// (NodeFileSystem, NodePath, NodeChildProcessSpawner) layers, and exposes:
//
//   - `layer`: the fully-composed Layer (for use inside test fixtures).
//   - `run()`: a Promise-returning function that launches the stack and
//     keeps it alive until interrupted (Ctrl-C / SIGINT). Returns a
//     promise that resolves on clean shutdown / rejects on fatal error.
//   - `runMain()`: same, but uses NodeRuntime.runMain so unhandled errors
//     are printed and the process exits non-zero on failure. Best for
//     CLI use.
//
// Optional knobs:
//   - `renderer`: 'tui' | 'plain' | 'silent'. Defaults to 'tui' when
//     stdout is a TTY, 'plain' otherwise (CI logs, piped output).
//   - `watch`: paths whose ChangeEvents should trigger a hot-restart of
//     the full stack (debounced 250ms). Disable per-event restart with
//     `hotRestart: false` while keeping the watcher running. Per-primitive
//     selective rebuild keys off the attribution surface in `ownersFor`
//     but isn't wired through Layer-cache invalidation yet — every event
//     restarts the whole scope.
//
// Compile-time graph closure is loose (option-tag positions widen R via
// `any`), so missing services surface at runtime via Effect's
// ServiceNotFound. That's acceptable for the dev-stack use case where
// you see the error within seconds of starting `pnpm dev`.

/* eslint-disable @typescript-eslint/no-explicit-any */

import * as crypto from 'node:crypto';
import * as nodeFs from 'node:fs/promises';
import * as nodePath from 'node:path';
import {
	Context,
	Effect,
	FileSystem,
	Layer,
	Path,
	Queue,
	Ref,
	Scope,
	Stdio,
	Stream,
	Terminal,
} from 'effect';
import { layer as NodeServicesLayer } from '@effect/platform-node/NodeServices';
import { runMain as nodeRunMain } from '@effect/platform-node/NodeRuntime';
import { ChildProcessSpawner } from 'effect/unstable/process';
import { minimatch } from 'minimatch';
import {
	buildDepGraph,
	computeDownstreamClosure,
	type DepGraph,
	type DownstreamClosure,
} from './dep-graph.js';
import { ClaimedContainers, dockerOrphanSweep, ensureRouter } from './docker.js';
import { prettyError } from './pretty-error.js';
import {
	EngineHandle,
	EngineLive,
	EndpointRegistryWithEngineLive,
	type EngineHandleShape,
} from './engine.js';
import { FileWatcher, FileWatcherLive } from './file-watcher.js';
import { Identity, deriveAppName, validateIdentity } from './identity.js';
import { LeasingLive } from './leasing.js';
import { Registry, RegistryLive, type RegistryNetwork } from './registry.js';
import { PortAllocatorLive } from './port-allocator.js';
import { resolveAppDir } from './resolve-app-dir.js';
import {
	AccountRegistryLive,
	CoinRegistryLive,
	DeepbookIndexerStateRegistryLive,
	DeepbookMarginStateRegistryLive,
	DeepbookServerStateRegistryLive,
	DeepbookStateRegistryLive,
	PackageRegistryLive,
	PostgresStateRegistryLive,
	PythStateRegistryLive,
	SealStateRegistryLive,
	SuiStateRegistryLive,
	WalrusStateRegistryLive,
} from './registries.js';
import { StateStore, StateStoreConfig, StateStoreLive } from './state-store.js';
import { ExtrasLive } from './extras.js';
import { resolveNetwork, type SuiNetwork } from './network.js';
import {
	type RendererFactory,
	type RendererKind,
	type RendererResolver,
	silentRendererFactory,
} from './renderer.js';
import type { TagKind } from '../advanced/tag.js';

// Shutdown copy surfaced via `engine.appendLog` in `onInterrupt`. A
// peer copy lives in `tui/components.tsx` for the q-keypress feedback
// path; both can drift independently — the constant is duplicated
// deliberately so the supervisor doesn't import upward into `tui/`.
const SHUTDOWN_LOG_MESSAGE =
	'Shutting down. Sui and other background services stay warm for a fast next start. Run `pnpm exec devstack wipe --yes` to clear all local state.';

// Structural shape of a stack member — anything carrying `__layer` (or
// a flattened `__layers` for composites). Once Phase 3b finishes
// inlining primitives, every entry in `config.stack` is a substrate
// `Ref<...>` and this alias collapses; for now it survives because the
// primitives' hand-rolled returns (`walrusLocalCluster`, `sealLocalKeygen`,
// …) carry `{__layer, __layers, key}` directly without going through
// `tag`/`provide`, so they don't satisfy `Ref`'s
// Context.Service brand.
export interface StackMember {
	readonly __layer: Layer.Layer<any, any, any>;
	// Composite primitives (seal, deepbook, walrus) build inner tags at
	// factory time and yield* them inside their own body. Each inner tag
	// carries its own layer, but defineDevstack only ever sees the parent
	// in `config.stack`. `__layers` is the flattened transitive layer
	// list — when present, we mergeAll those instead of just `__layer`
	// so inner-tag service resolution doesn't ServiceNotFound at runtime.
	readonly __layers?: ReadonlyArray<Layer.Layer<any, any, any>>;
	// Runtime-set on every tag produced by `tag` (it's the
	// Context.Service `key`). The type doesn't expose it on the public
	// `StackMember` interface because callers may also pass hand-rolled
	// layers (no `key`), but defineDevstack reads it best-effort to
	// pre-populate the TUI's pending-tag list.
	readonly key?: string;
	/**
	 * Section classification used by the TUI dashboard for grouping. Set
	 * automatically when the member was built via `provide` / `tag`
	 * with `{kind}`; absent for hand-rolled layers, which render in a
	 * fallback 'Other' section only when non-empty. Five values matching
	 * the new user-intent framing: services / packages / accounts /
	 * actions / app.
	 */
	readonly __kind?: TagKind;
	/**
	 * Friendly title surfaced by the dashboard while the member is still
	 * `pending` (before its build body runs and the in-build
	 * `setEntryTitle` fires). Mirrors the `displayTitle` option passed
	 * to `provide` / `tag`. Absence → fall back to the tag's key.
	 */
	readonly __displayTitle?: string;
	/**
	 * Filesystem paths the primitive's author wants watched for hot-restart.
	 * Mirrors the `watch` option passed to `provide` / `tag`.
	 * `defineDevstack` aggregates these into the runtime watch set
	 * alongside the top-level `config.watch`. Today this triggers a full
	 * stack restart; selective per-primitive tear-down is future work.
	 */
	readonly __watchPaths?: ReadonlyArray<string>;
	/**
	 * Plugin attribution — drives the leading `[plugin]` chip in the TUI and
	 * the row's section color. Mirrors the `plugin` option passed to
	 * `provide` / `tag`. See `ProvideOptions.plugin` for the canonical
	 * in-tree names.
	 */
	readonly __pluginName?: string;
}

export type { RendererKind };

export interface DevstackConfig {
	readonly stack: ReadonlyArray<StackMember>;
	/**
	 * Raw `app.extras` input passed through to the `Extras` /
	 * `ExtrasResolved` runtime services. Resolved once at infra-layer
	 * build time so `manifest-emit`, the codegen `StackHandleEmitter`,
	 * and `DappKitConfigEmitter` see the same record even when the
	 * input is non-pure (`() => ({ ts: Date.now() })`, registry-reading
	 * Effects).
	 */
	readonly extras?: import('./extras.js').ExtrasInput;
	readonly stateDir?: string;
	/**
	 * Logical stack name — partitions persisted state under
	 * `.devstack/stacks/<stack>/` on localnet so multiple devs/workers
	 * (e.g. vitest, playwright workers) can coexist without trampling
	 * one another's cache. Ignored on live nets. Defaults to `'main'`.
	 */
	readonly stackName?: string;
	/**
	 * Target Sui network. Drives state-file layout:
	 *   - `localnet` → `.devstack/stacks/<stackName>/state.json`
	 *   - other     → `.devstack/networks/<network>.json`
	 * Defaults to `'localnet'`.
	 */
	readonly network?: SuiNetwork;
	/**
	 * Status renderer to attach during `run()`. Defaults to `'tui'` when
	 * stdout is a TTY (interactive `pnpm dev`), `'plain'` otherwise (CI,
	 * piped output, test harnesses). Force `'silent'` if even the plain
	 * one-line-per-event stream is too noisy.
	 *
	 * The CLI `--renderer` flag (if set) overrides this.
	 *
	 * A `RendererKind` is resolved to a concrete `RendererFactory` via
	 * `rendererResolver`. `compose/devstack.ts` wires the default
	 * resolver (which knows about `tui/`); `engine/supervisor.ts`
	 * itself never imports tui modules.
	 */
	readonly renderer?: RendererKind;
	/**
	 * Resolves a `RendererKind` string into a concrete factory. Wired
	 * by `compose/devstack.ts` (which imports `tui/`) so the supervisor
	 * doesn't need an upward dependency on the renderer modules. Tests
	 * and advanced callers can pass their own resolver to swap in a
	 * fake renderer.
	 */
	readonly rendererResolver?: RendererResolver;
	/**
	 * Pre-resolved renderer factory. Wins over `renderer` /
	 * `rendererResolver` when set — `defineDevstack` uses it directly
	 * without consulting the resolver. Use this when the caller has a
	 * concrete factory in hand (e.g. a test harness wiring an in-memory
	 * renderer).
	 */
	readonly rendererFactory?: RendererFactory;
	/**
	 * Filesystem paths to observe for changes. When `hotRestart` is on
	 * (the default whenever `watch` is set), a change debounced to 250ms
	 * tears down the running stack and re-launches from scratch.
	 */
	readonly watch?: ReadonlyArray<string>;
	/**
	 * Enable hot-restart on `watch` events + on user-triggered force-run
	 * (TUI `r` keypress, or SIGUSR2 to the process). Defaults to `true`
	 * when `watch` is set and `false` otherwise — explicit `false` keeps
	 * the log-only behavior for `watch` users who don't want
	 * teardown-on-edit.
	 */
	readonly hotRestart?: boolean;
}

const resolveRendererKind = (config: DevstackConfig): RendererKind => {
	if (config.renderer !== undefined) return config.renderer;
	return process.stdout.isTTY === true ? 'tui' : 'plain';
};

/** Resolve a renderer factory from the config + per-run overrides.
 *  Precedence: explicit override factory → override kind via resolver →
 *  config factory → config kind via resolver → default kind via
 *  resolver. Missing resolver short-circuits to `silentRendererFactory`
 *  — calls into the supervisor that don't pass a resolver (rare; mostly
 *  tests) effectively run renderer-less. */
const resolveRendererFactory = (
	config: DevstackConfig,
	overrides: RunOverrides,
): RendererFactory => {
	if (overrides.rendererFactory !== undefined) return overrides.rendererFactory;
	const resolver = config.rendererResolver;
	if (overrides.renderer !== undefined) {
		return resolver !== undefined ? resolver(overrides.renderer) : silentRendererFactory;
	}
	if (config.rendererFactory !== undefined) return config.rendererFactory;
	if (resolver === undefined) return silentRendererFactory;
	return resolver(resolveRendererKind(config));
};

/** Overrides applied at `run()` time, layered on top of `DevstackConfig`. */
export interface RunOverrides {
	readonly renderer?: RendererKind;
	readonly rendererFactory?: RendererFactory;
}

/** The handle `defineDevstack(...)` / `devstack(...)` return. The handle
 *  carries the `Layer` graph (consumable by Effect-native callers) plus
 *  the `run` / `runMain` entry points the CLI invokes. */
export interface DevstackHandle {
	readonly layer: Layer.Layer<any, any, any>;
	readonly config: DevstackConfig;
	/** Launch the stack and wait until interrupted. Resolves on clean shutdown. */
	readonly run: (overrides?: RunOverrides) => Promise<void>;
	/** Launch via NodeRuntime — best for CLI entry points (handles signals, exit codes). */
	readonly runMain: (overrides?: RunOverrides) => void;
	/**
	 * Raw launch Effect — for callers (CLI) that want to `yield*` it inside
	 * their own outer NodeRuntime so SIGINT handlers reach the launch loop's
	 * finalizers (docker rm -f, etc.). Nesting `Effect.runPromise` inside an
	 * outer runtime breaks signal propagation.
	 */
	readonly launchEffect: (overrides?: RunOverrides) => Effect.Effect<void, unknown, never>;
}

// `NodeServicesLayer` bundles the five Node-platform services we need:
// FileSystem, Path, ChildProcessSpawner, Stdio, Terminal. Crucially it
// already uses `Layer.provideMerge` internally to satisfy
// ChildProcessSpawner's `FileSystem | Path` dependency before
// re-exporting it — a naive `Layer.mergeAll(...)` over the five
// individual layers leaves those deps unsatisfied and the resulting
// layer ServiceNotFounds at provide time.
const PlatformLive = NodeServicesLayer;

// Infra = stateful services every user-facing primitive may depend on.
// `EndpointRegistryWithEngineLive` requires `EngineHandle`, so we feed
// it the engine-and-friends merge via `provideMerge` (NOT the other way
// around — `Layer.provideMerge(self, that)` provides `that` to `self`,
// so the engine-consuming layer must be `self`). The merged output
// re-exports every infra service: EndpointRegistry plus all the rest.
//
// FileWatcher belongs here even though only defineDevstack consumes it
// today — keeping the merge flat means user code can `yield* FileWatcher`
// from inside a tag body without re-wiring the layer graph.
//
// StateStoreLive needs the per-devstack `StateStoreConfig` (stack +
// network) so it's wired up inside `defineDevstack` rather than here,
// where the config isn't yet known.
const InfraLiveCore = Layer.provideMerge(
	EndpointRegistryWithEngineLive,
	Layer.mergeAll(
		EngineLive,
		PackageRegistryLive,
		AccountRegistryLive,
		CoinRegistryLive,
		SuiStateRegistryLive,
		SealStateRegistryLive,
		WalrusStateRegistryLive,
		DeepbookStateRegistryLive,
		// State registries added after the per-service-state-registries fold
		// (commit 2bbbe44e) — `runtime/service.ts::gatherManifest` requires
		// these at finalization, so codegen and manifest-emit fail with
		// `Service not found: @devstack/<name>` when they're missing here.
		PythStateRegistryLive,
		PostgresStateRegistryLive,
		DeepbookIndexerStateRegistryLive,
		DeepbookServerStateRegistryLive,
		DeepbookMarginStateRegistryLive,
		PortAllocatorLive,
		LeasingLive,
		FileWatcherLive,
	),
);

// Shared infra recipe — config-derived StateStore + Identity layers used
// by BOTH `composeBootstrapLayer` and `composeStackLayer`. Centralised so
// the two call sites can't drift; in particular the `validateIdentity`
// guard (Phase D — rejects `..`, `/`, shell-meaningful characters in
// app/stack names before they flow into docker labels / filesystem
// paths) fires identically on both paths.
//
// `Layer.provideMerge` (not `provide`) on `StateStoreLive` re-exports
// `StateStoreConfig` from the resulting layer so user primitives can
// still `yield* StateStoreConfig` from inside their build body. A plain
// `Layer.provide` hides the config, and the acquire body fails with
// `ServiceNotFound: @devstack/StateStoreConfig` — silent until a
// user-facing primitive happens to consume it.
const buildBaseInfra = (
	opts: StackComposeOptions,
): {
	readonly stateStoreConfig: {
		readonly stack: string;
		readonly network: SuiNetwork;
		readonly stateDir?: string;
	};
	readonly StateStoreFullLive: Layer.Layer<unknown, unknown, never>;
	readonly IdentityLive: Layer.Layer<Identity, never, never>;
} => {
	const stateStoreConfig: {
		readonly stack: string;
		readonly network: SuiNetwork;
		readonly stateDir?: string;
	} = {
		stack: resolveStackName(opts.stackName),
		network: opts.network ?? resolveNetwork(),
		...(opts.stateDir !== undefined ? { stateDir: opts.stateDir } : {}),
	};
	const StateStoreConfigLive = Layer.succeed(StateStoreConfig, stateStoreConfig);
	const StateStoreFullLive = Layer.provideMerge(
		StateStoreLive,
		StateStoreConfigLive,
	) as Layer.Layer<unknown, unknown, never>;
	const identityShape = {
		app: deriveAppName(),
		stack: stateStoreConfig.stack,
		network: stateStoreConfig.network,
	};
	validateIdentity(identityShape);
	const IdentityLive = Layer.succeed(Identity, identityShape);
	return { stateStoreConfig, StateStoreFullLive, IdentityLive };
};

// Bootstrap = just enough to drive the TUI + watchers + signal handlers
// BEFORE the user stack starts acquiring. We want a primitive failure
// during `Layer.build(fullLayer)` to surface in the TUI (red `failed` +
// log entry) instead of leaking onto stdout as a fatal Layer.build
// abort.
//
// `StateStoreLive` lives here too — its acquire opens the file-backed
// `state.json.lock`, and a competing supervisor on the same stack should
// fail loudly BEFORE any docker work runs. Folding StateStore into the
// user-stack build worked only because `provideMerge`'s reduction order
// happened to evaluate it early; lifting it into the bootstrap layer
// makes "lock-first" a code-structure invariant. The lock's release
// finalizer runs on the supervisor's bootstrap scope (which lives for
// the whole runMain lifetime), so SIGINT / clean shutdown still removes
// the lock file. `Identity` is colocated because it's a cheap pure
// `Layer.succeed` derived from the same options.
//
// Same Live references as `InfraLiveCore` and `PlatformLive` so the
// memo-map shared with the user-stack build re-uses these — no duplicate
// `EngineLive` instance, no orphan `restartSignal` Deferred, and only
// ONE StateStore acquire (and therefore one lock-file write).

// Services the bootstrap layer is guaranteed to provide. Spelled out so
// `Context.get(bootstrapCtx, X)` and `Effect.provide(bootstrapCtx)` are
// type-checked: a missing wiring (e.g. `RegistryLive` dropped from the
// merge) becomes a compile error at the consumer site instead of a
// runtime `ServiceNotFound`.
type BootstrapServices =
	| EngineHandle
	| FileWatcher
	| StateStore
	| StateStoreConfig
	| Identity
	| Registry
	| ChildProcessSpawner.ChildProcessSpawner
	| FileSystem.FileSystem
	| Path.Path
	| Stdio.Stdio
	| Terminal.Terminal;

const composeBootstrapLayer = (
	opts: StackComposeOptions = {},
): Layer.Layer<BootstrapServices, unknown, never> => {
	const { StateStoreFullLive, IdentityLive } = buildBaseInfra(opts);
	const platform: Layer.Layer<unknown, unknown, never> =
		opts.platformLayer ?? (PlatformLive as Layer.Layer<unknown, unknown, never>);
	// Layer-order (innermost → outermost):
	//   1. StateStoreLive consumes FileSystem + StateStoreConfig — those
	//      have to be visible when it builds.
	//   2. Engine + FileWatcher + Identity sit alongside it as siblings.
	//   3. Platform provides FileSystem / Path / Child / Stdio / Terminal.
	//
	// `provideMerge` so platform services stay re-exported from the
	// composed bootstrap layer (Docker.run inside the user stack still
	// needs `yield* ChildProcessSpawner`).
	const bootstrapCore = Layer.mergeAll(
		EngineLive,
		FileWatcherLive,
		StateStoreFullLive,
		IdentityLive,
		RegistryLive,
	);
	return Layer.provideMerge(bootstrapCore, platform) as Layer.Layer<
		BootstrapServices,
		unknown,
		never
	>;
};

type EngineShape = EngineHandleShape;

// Bridge a POSIX signal into an Effect stream. Each signal becomes one
// emitted unit value; the consumer runs `engine.requestRestart` per
// event inside the supervisor's fiber tree (so the handler shows up in
// the tracer / logger and is interrupted by scope teardown). The
// stream's `Stream.callback` register block installs the `process.on`
// listener and an `Effect.addFinalizer` that removes it; running the
// stream via `Effect.forkScoped` ties everything to the surrounding
// scope so listener-detach + in-flight handler interrupt happen
// automatically on teardown.
//
// Effect v4 doesn't expose POSIX signal handling in core or
// `@effect/platform-node` (only SIGINT/SIGTERM are wired into
// `NodeRuntime.runMain` internally). Once it does, this can collapse to
// a one-line swap to whichever API surfaces.
const installSignalRestart = (
	signal: NodeJS.Signals,
	engine: EngineShape,
): Effect.Effect<void, never, import('effect/Scope').Scope> =>
	Effect.forkScoped(
		Stream.callback<void>((queue) =>
			Effect.gen(function* () {
				const handler = () => {
					Queue.offerUnsafe(queue, void 0);
				};
				process.on(signal, handler);
				yield* Effect.addFinalizer(() =>
					Effect.sync(() => {
						process.off(signal, handler);
					}),
				);
			}),
		).pipe(
			Stream.runForEach(() => engine.requestRestart),
			Effect.withSpan('Devstack.signalRestart', { attributes: { signal } }),
		),
	).pipe(Effect.asVoid);

// Per-file content-hash cache. Shared across all watcher fibers so a
// `fs.watch` event for a path we've already hashed compares against the
// last seen value and short-circuits the restart when bytes haven't
// changed (editor format-on-save with no diff, build tools touching mtime
// for incremental cache invalidation, etc.). Limitation: when multiple
// files change inside a single 250ms debounce window, the trailing event
// reports the LAST changed file only — if THAT file rolled back to a
// previously-seen hash but earlier files in the same save did change,
// we'd skip the restart. Acceptable: that pattern requires a tool that
// re-writes the same bytes on every save, which is rare. Directories +
// unreadable paths short-circuit to "real change" (no hash to compare).
const watchedFileHashes = new Map<string, string>();

const hashFileIfChanged = (
	filePath: string,
): Effect.Effect<{ readonly changed: boolean; readonly reason: string }> =>
	Effect.tryPromise({
		try: async () => {
			const stat = await nodeFs.stat(filePath);
			if (!stat.isFile()) {
				return { changed: true, reason: 'non-file (directory or special)' };
			}
			const content = await nodeFs.readFile(filePath);
			const hash = crypto.createHash('sha256').update(content).digest('hex');
			const prior = watchedFileHashes.get(filePath);
			watchedFileHashes.set(filePath, hash);
			if (prior === undefined) return { changed: true, reason: 'first sight' };
			if (prior === hash) return { changed: false, reason: 'content unchanged' };
			return { changed: true, reason: 'content changed' };
		},
		catch: (cause) => cause,
	}).pipe(Effect.catch(() => Effect.succeed({ changed: true, reason: 'hash failed' })));

// Owner of a watched path, as recorded at composition time. Used to
// attribute file-change events back to the primitive that declared the
// path via `provide({watch})` / `tag({watch})` so the supervisor
// can (a) log "the publishMove(hello) primitive owns this file — that's
// what triggered the restart" and (b) drive the affected-set computation
// in `formatRestartCascade` that feeds `engine.invalidateSubset` for the
// targeted, watch-driven re-acquire path. A single path may have multiple
// owners (two primitives watching overlapping directories), so
// attribution is a `ReadonlyArray`.
export interface WatchOwner {
	readonly key: string;
	readonly title: string;
	readonly absolutePath: string;
}

// `DownstreamClosure` (transitive-downstream closure from Phase 1's
// dep-graph derivation) is imported from `engine/dep-graph.ts` above
// and re-exported here so the Phase-5 diagnostic surface (which
// originally landed against a forward-declared placeholder) and its
// tests can keep their existing `import {...} from './supervisor.js'`
// shape. Semantics: `downstream.get(k)` is the set of primitive keys
// that transitively depend on `k`. The owner key itself is NOT
// included; callers union `{owner.key} ∪ downstream.get(owner.key)`
// to build the full affected set.
export type { DownstreamClosure } from './dep-graph.js';

// Heavy-infra reboot-cost annotations (R4 mitigation). When the affected
// set of a selective restart includes one of these primitives, the watch-
// fire log line surfaces the expected reboot cost so the operator can
// decide whether to roll forward or Ctrl-C + edit. Keys are matched against
// each affected primitive's key via a prefix test; the value is a
// human-readable cost phrase suitable for inline log embedding.
//
// Hardcoded list keeps the wiring honest: there's no opt-out flag the user
// can pass to suppress these warnings. If a dep graph routes Sui/Walrus
// downstream of a watch-fire, that's a graph bug — fix the graph, don't
// silence the warning. See `formatRestartCascade` for the rendering shape.
const HEAVY_INFRA_COSTS: ReadonlyMap<string, string> = new Map([
	['@devstack/SuiTag', 'Sui — ~90s reboot expected'],
	['@devstack/WalrusNetworkTag', 'Walrus — ~60s reboot expected'],
	['@devstack/SealKeyServerTag', 'Seal — ~30s reboot expected'],
	['@devstack/SealKeyManagerTag', 'Seal — ~30s reboot expected'],
]);

// Resolve the affected set's heavy-infra members into operator-readable
// cost phrases. Returns `[]` when none match — the caller appends to the
// log line only when non-empty.
const heavyInfraWarnings = (affected: ReadonlySet<string>): ReadonlyArray<string> => {
	const out: string[] = [];
	for (const key of affected) {
		const cost = HEAVY_INFRA_COSTS.get(key);
		if (cost !== undefined && !out.includes(cost)) out.push(cost);
	}
	return out;
};

// Format the watch-fire log line so the operator sees both *who* owns the
// changed path and *what else* will re-acquire transitively. The shape:
//
//   "file change at <path> (kind=…, <reason>) — owned by <titles>
//      — restarting (N downstream: <names>) [affected: <heavy-infra warn>]"
//
// `downstreamClosure === undefined` (Phase 1 not yet wired) collapses the
// cascade enumeration to just the owners, preserving today's log shape
// modulo wording. P2 lands the real graph and the cascade enumeration
// goes live without touching this helper.
//
// Returns both the log message AND the affected-set (owners ∪ downstream)
// — supervisor wires the latter into `engine.markSelectiveRestart` for the
// TUI dim-animation hook. Co-locating the two derivations here means
// a future change to the cascade computation can't desync the log line
// from the TUI signal.
//
// Exported for unit tests; the watch fiber is the only production caller.
export const formatRestartCascade = (
	owners: ReadonlyArray<WatchOwner>,
	downstreamClosure: DownstreamClosure | undefined,
): { readonly message: string; readonly affected: ReadonlySet<string> } => {
	const ownerTitles = owners.map((o) => o.title).join(', ');
	const affected = new Set<string>();
	const downstreamKeys = new Set<string>();
	for (const o of owners) {
		affected.add(o.key);
		const ds = downstreamClosure?.get(o.key);
		if (ds !== undefined) {
			for (const k of ds) {
				affected.add(k);
				downstreamKeys.add(k);
			}
		}
	}
	const cascade =
		downstreamKeys.size > 0
			? ` (${downstreamKeys.size} downstream: ${Array.from(downstreamKeys).join(', ')})`
			: '';
	const warnings = heavyInfraWarnings(affected);
	const warn = warnings.length > 0 ? ` — affected: ${warnings.join('; ')}` : '';
	return {
		message: `— owned by ${ownerTitles} — restarting${cascade}${warn}`,
		affected,
	};
};

// Resolve a changed file path back to the primitive(s) that own it.
// Absolute-path comparison handles the common case where the primitive
// declared a relative directory (e.g. `./move/hello`) and the watcher
// event reports a deep descendant file (`/abs/move/hello/sources/foo.move`).
// We accept both exact match and prefix-with-separator so partial-name
// collisions (`./move/hello-v2` vs `./move/hello`) don't false-positive.
// Exported for unit tests; the watcher fiber is the only production caller.
export const ownersFor = (
	changedPath: string,
	owners: ReadonlyArray<WatchOwner>,
): ReadonlyArray<WatchOwner> => {
	const abs = nodePath.resolve(process.cwd(), changedPath);
	return owners.filter(
		(o) => abs === o.absolutePath || abs.startsWith(o.absolutePath + nodePath.sep),
	);
};

// Built-in exclude patterns — always applied to every watch set so users don't
// have to repeat them on every primitive. Pattern syntax is the same `.gitignore`
// subset documented on `ProvideOptions.watch`: `**` matches any path segments,
// `*` matches anything except `/`, basenames anchored with `**/` match anywhere.
//
// Covers four classes of noise:
//   - Build outputs that the primitive's own acquire-cycle writes back to a
//     watched tree (`Move.lock`, `build/`, `package_summaries/`, `dist/`,
//     `target/`, `.next/`, `.turbo/`, …). Without filtering, these self-trigger
//     a hot-restart → re-publish → write same outputs → loop.
//   - Devstack's own state dir (`.devstack/`). Snapshot capture, state-store
//     entries, port-allocator locks, codegen `.gitignore` all live here.
//   - Conventional codegen output (`generated/`). `Codegen({})` atomic-renames
//     `<out>.staging-…` → `<out>` each cycle; the rename surfaces as an fs
//     event. Users overriding `output:` to a non-`generated` basename get the
//     same protection via a negation pattern in the primitive's own `watch:`.
//   - Editor / IDE atomic-save intermediaries (vim's swap, JetBrains atomic
//     save, emacs lock files, TS `*.tsbuildinfo`).
//
// Always-applied negation patterns; primitive authors don't need to repeat
// them. A user who actively wants to react to a `dist/` file change (very
// unusual) would have to declare a positive watch outside the always-excluded
// scope.
export const DEFAULT_WATCH_EXCLUDES: ReadonlyArray<string> = [
	// Build outputs (Move + Node + Rust + Next + Turbo + Vite + cache dirs)
	'**/build/**',
	'**/dist/**',
	'**/target/**',
	'**/.next/**',
	'**/.turbo/**',
	'**/.cache/**',
	'**/.vite/**',
	'**/coverage/**',
	'**/node_modules/**',
	// Move toolchain (rewritten on every `sui move build`)
	'**/Move.lock',
	'**/Move.lock.new',
	// `sui move build` shells out to gawk to scrub the `pinned` section
	// of `Move.lock`; gawk writes to `Move.lock.gawk.<random>` first
	// and atomically renames over `Move.lock`. The intermediate file's
	// random suffix means we can't enumerate it ahead of time —
	// glob-match instead. Without this, every Move build's gawk temp
	// triggers a hot-restart → republish → another gawk temp → loop.
	'**/Move.lock.gawk.*',
	'**/package_summaries/**',
	// Devstack's own state + conventional codegen output
	'**/.devstack/**',
	'**/generated/**',
	// VCS metadata
	'**/.git/**',
	// macOS noise
	'**/.DS_Store',
	// Editor / IDE atomic-save intermediaries
	'**/*.swp',
	'**/*.swx',
	'**/*~',
	'**/*.tsbuildinfo',
	'**/#*#', // emacs lock files
	'**/___jb_tmp___*', // JetBrains atomic save
	'**/4913', // vim's "atomic save probe" temp file
];

/**
 * Compile a primitive/config watch pattern array into a single filter function.
 *
 * Patterns follow the `.gitignore` subset documented on `ProvideOptions.watch`:
 *  - Bare paths (no `*`/`?`) are include prefixes — they match the path and
 *    everything beneath it.
 *  - Leading `!` negates (`!**\/build/**`).
 *  - `**` / `*` / `?` glob wildcards via `minimatch`.
 *
 * A path triggers restart iff some positive pattern matches AND no negation
 * pattern matches. Built-in {@link DEFAULT_WATCH_EXCLUDES} are always prepended
 * to the negation set so callers don't repeat `node_modules`, `.git`, etc.
 *
 * Returns a function — call it on absolute paths only. Relative paths from
 * `fs.watch` should be joined against the watch root before passing in.
 *
 * Exported for unit tests; the watcher fiber is the only production caller.
 */
export const compileWatchFilter = (
	patterns: ReadonlyArray<string>,
	cwd: string = process.cwd(),
): ((absPath: string) => boolean) => {
	const includes: string[] = [];
	const excludes: string[] = [...DEFAULT_WATCH_EXCLUDES];
	const hasGlobMeta = (s: string): boolean => /[*?[\]{}]/.test(s);
	const resolveOne = (raw: string): string => {
		// Anchored-anywhere (`**/...`) and absolute patterns pass through.
		if (raw.startsWith('**/') || nodePath.isAbsolute(raw)) return raw;
		// Bare relative paths resolve against cwd; relative globs do too.
		return nodePath.resolve(cwd, raw);
	};
	for (const raw of patterns) {
		const isNeg = raw.startsWith('!');
		const body = isNeg ? raw.slice(1) : raw;
		const resolved = resolveOne(body);
		const target = isNeg ? excludes : includes;
		if (hasGlobMeta(resolved)) {
			target.push(resolved);
		} else {
			// Bare dir/path: match the path itself AND its descendants.
			target.push(resolved);
			target.push(`${resolved}/**`);
		}
	}
	return (absPath: string): boolean => {
		if (excludes.some((p) => minimatch(absPath, p, { dot: true }))) return false;
		return includes.some((p) => minimatch(absPath, p, { dot: true }));
	};
};

/**
 * Back-compat shim for the old basename-only filter. Returns true when the
 * path matches one of {@link DEFAULT_WATCH_EXCLUDES} — used by the few call
 * sites that just want to know "is this noise?" without the full positive-set
 * machinery (notably the existing supervisor.test.ts coverage).
 *
 * New call sites should use {@link compileWatchFilter} so they get the
 * positive-set semantics too.
 */
export const isIgnoredWatchPath = (absOrRelPath: string): boolean => {
	const abs = nodePath.isAbsolute(absOrRelPath)
		? absOrRelPath
		: nodePath.resolve(process.cwd(), absOrRelPath);
	return DEFAULT_WATCH_EXCLUDES.some((p) => minimatch(abs, p, { dot: true }));
};

// File-watcher fiber. When `hotRestart` is on, events are debounced 250ms
// and the trailing edge signals the engine; coalescing avoids tearing the
// stack down once per character of a multi-keystroke save. Otherwise we
// just log so users see the wiring is alive.
//
// `watchFilter` is the compiled positive/negation predicate built from
// every primitive's `__watchPaths` + `config.watch` + `DEFAULT_WATCH_EXCLUDES`
// at compose time. The watcher receives ALL fs events for `path`'s subtree
// (recursive fs.watch) and trusts the filter to decide which events warrant
// a restart. Filtering before debounce so an excluded write can't swallow
// a real source edit in the same window.
const watchPathFiber = (
	path: string,
	engine: EngineShape,
	hotRestart: boolean,
	owners: ReadonlyArray<WatchOwner>,
	watchFilter: (absPath: string) => boolean,
	downstreamClosure: DownstreamClosure | undefined,
): Effect.Effect<void, never, FileWatcher | import('effect/Scope').Scope> =>
	Effect.gen(function* () {
		const watcher = yield* FileWatcher;
		const stream = watcher.watch(path).pipe(
			Stream.filter((event) => {
				// fs.watch emits filenames relative to the watch root; join
				// before passing to the absolute-path filter.
				const abs = nodePath.isAbsolute(event.path)
					? event.path
					: nodePath.join(path, event.path);
				return watchFilter(abs);
			}),
		);
		const drained = hotRestart
			? Stream.runForEach(stream.pipe(Stream.debounce('250 millis')), (event) =>
					Effect.gen(function* () {
						const { changed, reason } = yield* hashFileIfChanged(event.path);
						if (!changed) {
							yield* Effect.logDebug(`file change at ${event.path} ignored (${reason})`);
							return;
						}
						// Attribution: resolve the changed path back to the
						// primitives that declared it. Bare `config.watch`
						// entries surface as "(unowned)" — those paths can't
						// be tied to a specific primitive, so we fall back to
						// a full `requestRestart` for them (the user wired
						// them up via `config.watch` and asked for a restart
						// trigger, but didn't tell us which primitive owns
						// them). Per-primitive `__watchPaths` declarations
						// take the targeted `invalidateSubset` path.
						const matched = ownersFor(event.path, owners);
						if (matched.length > 0) {
							// Co-derive the log message and the affected set
							// in one place so the diagnostic line, the TUI
							// dim-animation signal, and `invalidateSubset`
							// can't disagree about which primitives are in
							// scope. The helper takes the
							// `downstreamClosure` from Phase 1 and unions
							// `{owner.key} ∪ downstream[owner.key]` across
							// every matched owner; the resulting `affected`
							// set is the input to both the TUI signal and
							// the engine's selective teardown.
							const { message, affected } = formatRestartCascade(matched, downstreamClosure);
							yield* Effect.logInfo(
								`file change at ${event.path} (kind=${event.kind}, ${reason}) ${message}`,
							);
							yield* engine.markSelectiveRestart(affected);
							// Targeted teardown: close the scopes of the
							// affected primitives and evict their shadow-cache
							// entries. The next consumer's `yield*` re-enters
							// the Layer build, which allocates a fresh
							// per-primitive scope and re-runs the build body.
							// Siblings outside `affected` keep their value,
							// their scope, and their TUI row state.
							yield* engine.invalidateSubset(affected);
						} else {
							yield* Effect.logInfo(
								`file change at ${event.path} (kind=${event.kind}, ${reason}) ` +
									`— unowned watch path — restarting`,
							);
							// Unowned watch path: no primitive declared this
							// via `__watchPaths`, so we can't compute an
							// affected set. Fall back to a full restart —
							// the user explicitly wired this path via
							// `config.watch` so a coarse restart is the
							// honest semantic (we don't know what consumer
							// to invalidate; assume the whole stack might
							// depend on it).
							yield* engine.requestRestart;
						}
					}),
				)
			: Stream.runForEach(stream, (event) =>
					Effect.logWarning(
						`file change at ${event.path} (kind=${event.kind}); hotRestart disabled`,
					),
				);
		// Watcher errors (and defects) collapse to a single warning so an
		// fs.watch failure on one path can't tear down the whole devstack.
		const guarded = Effect.catchCause(drained, (cause) =>
			Effect.logWarning(`file watcher for ${path} failed: ${String(cause)}`),
		);
		yield* Effect.forkScoped(
			guarded.pipe(Effect.withSpan('Devstack.watch', { attributes: { path } })),
		);
	});

/**
 * Subset of `DevstackConfig` knobs that affect layer composition (vs the
 * runner-side TUI / watcher knobs). Consumed by `defineDevstack` via
 * `composeStackLayer`; the bootstrap path uses the same shape so the
 * `validateIdentity` guard and stack/network resolution stay in sync.
 */
export interface StackComposeOptions {
	readonly stackName?: string;
	readonly network?: SuiNetwork;
	readonly stateDir?: string;
	/**
	 * Raw `app.extras` input. Resolved once at infra-layer build time
	 * into `ExtrasResolved` so manifest emit + codegen emitters
	 * (`StackHandleEmitter`, `DappKitConfigEmitter`) all see the same
	 * record even when the input is non-pure.
	 */
	readonly extras?: import('./extras.js').ExtrasInput;
	/**
	 * Override the outer Platform layer (FileSystem / Path /
	 * ChildProcessSpawner / Stdio / Terminal). Intended for integration
	 * tests that want to swap the real Node spawner for an in-memory
	 * fake; production code never sets this.
	 */
	readonly platformLayer?: Layer.Layer<unknown, unknown, never>;
	/**
	 * Optional layer of overrides merged into `InfraLive` AFTER the
	 * default infra layers — `Layer.mergeAll`'s later-wins semantics let
	 * the override shadow the default `PortAllocatorLive` / registry /
	 * engine implementations. Intended for integration tests that want
	 * deterministic behaviour (e.g. a `PortAllocator` that always
	 * returns the preferred port without doing real TCP bind probes);
	 * production code never sets this.
	 *
	 * Unlike `platformLayer` (which sits at the OUTER ring and is
	 * `provideMerge`-d under InfraLive — so its services don't shadow
	 * infra), this is merged INTO the infra ring, so it CAN shadow
	 * services that the user stack consumes via `yield* SomeService`.
	 */
	readonly infraOverrides?: Layer.Layer<unknown, unknown, never>;
}

// Resolve the effective stack name. Precedence:
//   1. Explicit `opts.stackName` (user passed it to defineDevstack)
//   2. `DEVSTACK_STACK` env var (CLI tests / per-stack invocations)
//   3. `'main'` default
// Keeping the env var as a fallback lets `DEVSTACK_STACK=test pnpm dev`
// boot the supervisor on the per-test stack the way Playwright e2e
// suites expect (the manifest + keys land under
// `.devstack/stacks/test/`).
const resolveStackName = (configured: string | undefined): string =>
	configured ?? process.env.DEVSTACK_STACK ?? 'main';

/**
 * Compose a user-supplied `stack` into the fully-resolved Devstack
 * Layer: every tag's `__layer(s)` merged together, then wrapped with
 * infrastructure (engine, registries, state store, identity, extras)
 * and platform (Node FileSystem / Path / ChildProcessSpawner / Stdio /
 * Terminal) layers. Returned as `Layer<unknown, unknown, never>` because
 * each primitive contributes its own service / error vocabulary; the
 * caller resolves services from Context at runtime.
 *
 * Consumed by `defineDevstack`, which wraps the result in a launch
 * loop. The base infra (StateStore + Identity) is built via the same
 * `buildBaseInfra` helper the bootstrap layer uses, so the lock-first
 * invariant and identity validation stay in sync between paths.
 */
export const composeStackLayer = (
	stack: ReadonlyArray<StackMember>,
	opts: StackComposeOptions = {},
): Layer.Layer<unknown, unknown, never> => {
	// Duplicate-service guard. `Layer.mergeAll` lets later layers shadow
	// earlier ones for the same Context tag, which silently turns
	// `[suiLocalnet(), suiTestnet()]` into "whatever the last one is" —
	// almost always a config bug. We only inspect the TOP-LEVEL members'
	// `key`s: composite primitives flatten inner tags into `__layers` with
	// keys that may legitimately collide between siblings (e.g. two
	// composites that both pull in a shared sub-tag), so checking the
	// flattened set would false-positive. We warn rather than fail because
	// rare legitimate cases (e.g. two hand-rolled layers with the same
	// key) might surface here.
	const seenKeys = new Set<string>();
	for (const member of stack) {
		const key = (member as { key?: string }).key;
		if (key === undefined) continue;
		if (seenKeys.has(key)) {
			// Plain console.warn — we're inside synchronous layer assembly,
			// outside any Effect/fiber context, so `Effect.logWarning` would
			// require a `runSync` that bypasses the TUI's logger sink anyway.
			console.warn(
				`Devstack: duplicate service detected: ${key}. Last one wins. Composing two implementations of the same interface (e.g. both suiLocalnet() and suiTestnet()) is almost certainly a bug.`,
			);
		}
		seenKeys.add(key);
	}

	// Prefer `__layers` (transitively-flattened) when a composite tag
	// supplies it; fall back to the single `__layer` for tags built via
	// the simple `tag(name, build)` shape or the hand-rolled `Sui`
	// canonical pattern in `sui.ts`.
	const stackLayers = stack.flatMap((m) => m.__layers ?? [m.__layer]);
	// Fold the user stack with `provideMerge` so each layer can consume
	// services produced by anything earlier in the stack. `Layer.mergeAll`
	// builds siblings in parallel without wiring outputs to inputs — a
	// later tag (e.g. `accountAlice` doing `yield* Sui`) would see Sui as
	// an unsatisfied RIn even though `suiLocalnet()` sits next to it in
	// the stack, and the merged layer would `ServiceNotFound` at build
	// time. `provideMerge(self, that)` provides `that`'s outputs to `self`
	// AND re-exports both, which is exactly the "each new layer can
	// consume everything already accumulated" semantic we want. Reduction
	// order is the stack's authoring order — users (and composite
	// primitives' `__layers`) list providers before consumers, so we just
	// fold left-to-right with `provideMerge(newLayer, acc)`.
	// Accumulator widens to `Layer<any, any, any>` because each stack
	// member's `__layer` declares its services through opaque tag
	// identities — there's no precise type for "the heterogeneous union
	// of all prior outputs". Contravariance on `ROut` means `Layer<never>`
	// doesn't auto-widen, so we route the seed through `Layer.Any` (the
	// canonical "some Layer" constraint type) and reduce from there.
	// Drops the previous `as unknown as Layer<any,any,any>` round-trip.
	const seed: Layer.Any = Layer.empty;
	const userLayer = stackLayers.reduce<Layer.Layer<any, any, any>>(
		(acc, layer) => Layer.provideMerge(layer, acc),
		seed as Layer.Layer<any, any, any>,
	);

	// Per-devstack state-store + identity. Built via the shared
	// `buildBaseInfra` helper so this path stays consistent with
	// `composeBootstrapLayer`'s identity validation + lock-file invariant.
	// `Identity` flows the resolved `<app, stack, network>` triple into
	// `Docker.run` so every container we launch gets stamped with
	// `--label devstack.app=... --label devstack.stack=... --label
	// devstack.action=...` and so the container/compose-project name
	// includes the network suffix on non-localnet. `wipe` / `stack down`
	// filter on these labels.
	const { StateStoreFullLive, IdentityLive } = buildBaseInfra(opts);
	// `Extras` holds the user's raw `app.extras` input (undefined when
	// `devstack({ extras })` wasn't set). manifest-emit + codegen yield
	// it and resolve on their own time, inside their own scope where
	// the refs the user's extras Effect depends on are already acquired.
	const ExtrasInfraLive = ExtrasLive(opts.extras);
	// `infraOverrides` (when set) is merged LAST so `Layer.mergeAll`'s
	// later-wins semantics shadow any duplicate tag in `InfraLiveCore`
	// (e.g. a deterministic `PortAllocator` for integration tests).
	const InfraLive =
		opts.infraOverrides !== undefined
			? Layer.mergeAll(
					InfraLiveCore,
					StateStoreFullLive,
					IdentityLive,
					ExtrasInfraLive,
					opts.infraOverrides as Layer.Layer<any, any, any>,
				)
			: Layer.mergeAll(InfraLiveCore, StateStoreFullLive, IdentityLive, ExtrasInfraLive);

	// Layer-order rationale (innermost → outermost):
	//   1. `userLayer` consumes infra (Engine, registries, StateStore,
	//      Identity) — sits innermost so those services are visible to
	//      every primitive body.
	//   2. `InfraLive` provides infra and itself consumes platform
	//      (FileSystem / Path / ChildProcessSpawner / Stdio / Terminal)
	//      — middle ring, satisfies (1) and demands (3).
	//   3. `PlatformLive` provides the Node-platform services with no
	//      further dependencies — outermost, closes the graph.
	//
	// We use `provideMerge` (NOT `provide`) so the composed layer's ROut
	// re-exports inner-ring services. `Layer.provide(self, that)` hides
	// `that`'s outputs, which would leave `fullLayer` only exposing
	// `userLayer`'s service tags — `Context.get(ctx, EngineHandle)` in
	// the run loop, and `yield* FileSystem.FileSystem` from consumer
	// code that resolves services from `fullLayer` directly, would both
	// ServiceNotFound at runtime. provideMerge keeps the internal wiring
	// intact while still re-exporting upward.
	const withInfra = Layer.provideMerge(userLayer, InfraLive);
	// platformLayer is typed as the widest `Layer<unknown,…>` shape because
	// the caller resolves services from the composed layer via
	// `Context.get(tag)` at runtime and accepts ServiceNotFound for absent
	// tags. The default `PlatformLive` is a narrower `Layer<NodeServices,…>`;
	// the cast widens (no `any` round-trip).
	const platform: Layer.Layer<unknown, unknown, never> =
		opts.platformLayer ?? (PlatformLive as Layer.Layer<unknown, unknown, never>);
	const fullLayer = Layer.provideMerge(withInfra, platform);
	return fullLayer as Layer.Layer<unknown, unknown, never>;
};

export const defineDevstack = (
	input: ReadonlyArray<StackMember> | DevstackConfig,
): DevstackHandle => {
	const config: DevstackConfig = Array.isArray(input)
		? { stack: input }
		: (input as DevstackConfig);

	const fullLayer = composeStackLayer(config.stack, {
		stackName: config.stackName,
		network: config.network,
		stateDir: config.stateDir,
		extras: config.extras,
	});

	// Identity values used for the pre-build orphan sweep below. Mirrors
	// the values `composeStackLayer` stamps into the `Identity` service so
	// the sweep targets the same compose-project label (which is
	// `{app}` for the default `main`/`localnet`, `{app}-{stack}` when only
	// stack deviates, `{app}-{network}` when only network deviates, and
	// `{app}-{stack}-{network}` when both do) that `Docker.run` writes
	// onto every container.
	const sweepApp = deriveAppName();
	const sweepStack = resolveStackName(config.stackName);
	const sweepNetwork: SuiNetwork = config.network ?? 'localnet';

	// Best-effort: collect every stack member's tag key + classification +
	// pending-state title for the TUI's initial seed. Members carry `__kind`
	// when they're built via `tag` / `provide` with `{kind}` set —
	// without it the engine lands the entry in the 'other' section, which
	// the renderer elides until it has content. `__displayTitle` (also set
	// via the `displayTitle` option) gives the row a friendly label while
	// the primitive is still `pending`, so users see `sui.localnet` instead
	// of `@devstack/Sui` before the build body has a chance to run
	// `setEntryTitle`. Tags without a runtime `key` (rare — only
	// hand-rolled `Layer`s lacking the Context.Service shape) get a
	// generated fallback so the TUI still surfaces them.
	const seedEntries: ReadonlyArray<{
		readonly key: string;
		readonly kind?: TagKind;
		readonly title?: string;
		readonly plugin?: string;
	}> = config.stack.flatMap((m, i) => {
		// Hidden tags (e.g. `gitFetch`) opt out of the dashboard entirely —
		// see `ProvideOptions.hidden`. Skipping the seed keeps the row from
		// flashing during the pending → acquiring → ready transition; the
		// matching `withEngineLifecycle` skip prevents any later auto-register.
		if ((m as { __hidden?: boolean }).__hidden === true) return [];
		const key = (m as { key?: string }).key ?? `stack[${i}]`;
		const kind = (m as { __kind?: TagKind }).__kind;
		const title = (m as { __displayTitle?: string }).__displayTitle;
		const plugin = (m as { __pluginName?: string }).__pluginName;
		const entry: { key: string; kind?: TagKind; title?: string; plugin?: string } = { key };
		if (kind !== undefined) entry.kind = kind;
		if (title !== undefined) entry.title = title;
		if (plugin !== undefined) entry.plugin = plugin;
		return [entry];
	});

	// Watch set = explicit `config.watch` plus every primitive that
	// declared paths via `provide({watch})` / `tag({watch})`. `publishMove`
	// auto-watches its Move source tree so a `.move` edit triggers a
	// hot-restart (which cascades through `bindings` regen + frontend HMR)
	// without the user having to repeat the Move path in `config.watch`.
	// `Codegen` declares its output dir as a `!`-negation so the
	// atomic-rename swap each cycle doesn't loop the watcher.
	//
	// Three derived structures:
	//   - `rawWatchPatterns`: the full gitignore-style spec — positives
	//     and `!`-negations from every source. Fed into `compileWatchFilter`
	//     so DEFAULT_WATCH_EXCLUDES are layered in for free.
	//   - `watchRoots`: concrete dirs we call `fs.watch` on. Derived from
	//     bare positive patterns (no glob meta). Glob-only or negation-only
	//     patterns contribute to the filter but not to the set of roots —
	//     they piggyback on whatever other pattern provided a concrete root.
	//   - `watchOwners`: per-primitive attribution metadata so the diagnostic
	//     log can say "owned by publish.vault" instead of a bare path.
	//     Only bare positive paths participate; primitives that declare
	//     only globs or negations surface as "(unowned)" in the diagnostic.
	//     Selective per-primitive Layer-cache invalidation (so unchanged
	//     primitives skip rebuild) is tracked as a separate plan — the
	//     attribution surface here is the foundation it will key on.
	const hasGlobMeta = (s: string): boolean => /[*?[\]{}]/.test(s);
	const rawWatchPatterns: ReadonlyArray<string> = [
		...(config.watch ?? []),
		...config.stack.flatMap(
			(m) => (m as { __watchPaths?: ReadonlyArray<string> }).__watchPaths ?? [],
		),
	];
	const watchFilter = compileWatchFilter(rawWatchPatterns);
	const watchOwners: ReadonlyArray<WatchOwner> = config.stack.flatMap((m, i) => {
		const paths = (m as { __watchPaths?: ReadonlyArray<string> }).__watchPaths ?? [];
		if (paths.length === 0) return [];
		const key = (m as { key?: string }).key ?? `stack[${i}]`;
		const title = (m as { __displayTitle?: string }).__displayTitle ?? key;
		return paths
			.filter((p) => !p.startsWith('!') && !hasGlobMeta(p))
			.map((p) => ({
				key,
				title,
				absolutePath: nodePath.resolve(process.cwd(), p),
			}));
	});
	const watchRoots = Array.from(
		new Set(
			rawWatchPatterns
				.filter((p) => !p.startsWith('!') && !hasGlobMeta(p))
				.map((p) => (nodePath.isAbsolute(p) ? p : nodePath.resolve(process.cwd(), p))),
		),
	);
	// Static dep graph (Phase 1 of selective-restart). Built once per
	// supervisor lifetime — `config.stack` is static across hot-restart
	// cycles, so the graph (and its closure) is too. Phase 2 wires the
	// closure into the watch fiber so the diagnostic + TUI surface (P5)
	// enumerates the downstream cascade and warns on heavy-infra entries;
	// Phase 3 wires it into `engine.invalidateSubset` for targeted
	// invalidation. `depGraph` itself is kept around for Phase 3's
	// per-primitive scope re-acquire logic, which keys on the upstream
	// edges to decide which primitives the watch-fire must invalidate.
	const depGraph: DepGraph = buildDepGraph(config.stack);
	const downstreamClosure: DownstreamClosure = computeDownstreamClosure(depGraph);
	void depGraph;
	// `hotRestart` only governs FILE-WATCH-driven restarts. User-driven
	// restarts (TUI `r` key, SIGUSR2) ALWAYS recycle — pressing `r` is the
	// explicit "I want to restart" gesture and would be inexplicable if the
	// flag silently turned it into a quit.
	const hotRestart = config.hotRestart ?? watchRoots.length > 0;

	const headerApp = deriveAppName();
	const headerStack = resolveStackName(config.stackName);
	const headerNetwork = config.network ?? 'localnet';

	// Bootstrap layer for the supervisor: engine + filewatcher + platform
	// + state-store + identity. Built once per `defineDevstack` so the
	// state-store lock identity (path + instanceId derived inside its
	// build body) stays consistent across cycles. Both this layer and the
	// user-stack `fullLayer` build their StateStore + Identity via
	// `buildBaseInfra`; the shared memo-map between bootstrap and stack
	// builds means the second acquire is a memoised no-op — only one
	// lock-file write per supervisor.
	const bootstrapLayer = composeBootstrapLayer({
		stackName: config.stackName,
		network: config.network,
		stateDir: config.stateDir,
	});

	const buildLaunchEffect = (overrides: RunOverrides): Effect.Effect<void, unknown, never> => {
		const rendererFactory = resolveRendererFactory(config, overrides);
		const rendererKind = rendererFactory.kind;

		// The user-stack layer's identity is stable across cycles
		// (`config` is closed-over, not derived from per-cycle state),
		// so hoist it out of `runOnce`. Inside `runOnce` we re-pass it
		// to `Layer.buildWithMemoMap`; the MemoMap reuses already-built
		// entries for shared infra services and only rebuilds the
		// per-cycle childScope state. Pre-fix, building the layer in
		// the runOnce body created a NEW `Layer.succeed(StateStoreConfig,
		// ...)` instance per cycle whose layer key was fresh, defeating
		// MemoMap dedupe for the StateStore acquire (HIGH-S3).
		const userStackLayer = composeStackLayer(config.stack, {
			stackName: config.stackName,
			network: config.network,
			stateDir: config.stateDir,
			extras: config.extras,
			platformLayer: undefined,
		});

		// Per-cycle iteration. Strictly per-cycle work — bootstrap,
		// traefik ensure, watcher fibers, SIGUSR2 install, TUI mount,
		// and plain-renderer fork all live on the outer launch scope.
		// Topology:
		//
		//   longLived ── outer launch scope (lives for runMain)
		//     │
		//     ├── bootstrapCtx     (engine + watchers + StateStore +
		//     │                     Identity + platform) — built ONCE,
		//     │                     survives `r` / file-watch cycles
		//     │
		//     ├── watcher fibers + SIGUSR2 handler — installed once
		//     │
		//     └── supervisorScope ── runOnce's per-cycle scope
		//           │
		//           ├── childScope[A]   (Sui)            ─┐
		//           ├── childScope[B]   (accountAlice)    ├─ each forked
		//           ├── childScope[C]   (publishMove)     │  off
		//           │                                     ┘  supervisorScope
		//           │                                     by Effect's MemoMap
		//           │                                     (one scope per
		//           │                                     Layer.effect — see
		//           │                                     `withEngineLifecycle`).
		//           │
		//           └── restart-await fiber — blocks on engine's restart
		//                                     signal; returns from runOnce
		//
		// `r` (full rebuild) closes `supervisorScope`, cascading finalize
		// to every primitive in finalize order. Selective watch-fires
		// (Phase 3 of selective-restart) release ONLY the primitives in
		// the affected closure via `engine.invalidateSubset`, leaving
		// siblings and bootstrap services untouched. Bootstrap services
		// (engine, StateStore, watchers) are stable across cycles because
		// they live on `longLived`, not on the per-cycle scope.
		const runOnce = (cycle: number, engine: EngineShape, memoMap: Layer.MemoMap) => {
			// Apply the renderer's logger layer to the WHOLE per-cycle body
			// so every `Effect.log*` call inside the cycle (build effects,
			// orphan-sweep status, restart-trigger diagnostics, …) goes
			// through `engine.appendLog` and lands in the TUI log panel.
			// Previously this layer was scoped only to `Layer.buildWithMemoMap`
			// (line ~1178 below) so calls outside the build (notably the
			// orphan-sweep `swept N orphan container(s)` line) fell through
			// to Effect's default logger and printed to stderr in the
			// `[HH:MM:SS.mmm] INFO (#1): …` format, breaking the TUI layout.
			const loggerLayer = rendererFactory.loggerLayer(engine);
			return Effect.gen(function* () {
				// Fork a parallel-finalizer child of the ambient per-cycle
				// scope. This is THE scope every primitive's layer-build
				// effect runs on (each primitive's `Effect.scope` resolves
				// to a child of this) — so `docker stop` finalizers
				// registered by Docker.run land on per-primitive scopes
				// that are children of this parent. Without the parallel
				// strategy here, scope-close fires those per-primitive
				// finalizers SEQUENTIALLY: each container's `docker stop
				// --time N` blocks the next, so net teardown = sum(grace)
				// instead of max(grace). Verified in plain-mode logs:
				// seal's `ready → stopping` fired 15s after SIGINT
				// (seal grace), walrus's another 15s later, sui's another
				// after that — totaling ~45s when parallel would be ~30s.
				// Parallel here keeps Layer-build's ACQUIRE ordering intact
				// (dependencies build before dependents, sequentially); only
				// RELEASE fires concurrently. Safe for docker workloads
				// because containers stop independently — there's no
				// inter-container dependency at the OS level even when
				// there's one at the Layer level.
				const supervisorAmbient = yield* Effect.scope;
				const supervisorScope = yield* Scope.fork(supervisorAmbient, 'parallel');

				// Race the close of every per-primitive scope alongside the
				// Layer.buildWithMemoMap cleanup cascade. Without this, the
				// nested `Layer.provideMerge` chain produces a deeply-nested
				// tree of *sequential* `fromBuild` scopes — supervisorScope
				// has just ONE direct finalizer (close of the outermost
				// fromBuild scope), so its 'parallel' strategy has nothing to
				// parallelize and docker-stop finalizers fire one primitive
				// at a time in LIFO order (seal 15s → walrus 20s → sui 30s in
				// the private-content stack, ~65s of serial waits).
				//
				// Registering `invalidateAll` as a sibling finalizer on
				// supervisorScope means BOTH fire when supervisorScope closes
				// — and supervisorScope's 'parallel' strategy now actually
				// runs them concurrently. `invalidateAll` walks every
				// registered primitive scope in `Effect.all({ concurrency:
				// 'unbounded' })`, so each primitive's `docker stop` finalizer
				// fires from a sibling fiber. The Layer-build cascade still
				// runs in parallel with it, but every scope it reaches is
				// already Closed (idempotent) so the cascade collapses to a
				// fast no-op. Net effect: shutdown is ~max(grace) ≈ 30s for
				// the private-content stack instead of ~sum(grace) ≈ 65s,
				// AND sui-localnet gets its full 30s grace timer from T=0
				// (no more SIGKILL exit-137 "dirty shutdown" alert on the
				// next `up`).
				yield* Scope.addFinalizer(supervisorScope, engine.invalidateAll);

				// Per-cycle claim set: every container `Docker.run` either adopts
				// (reuse-if-healthy hit) or creates is appended here. After the
				// layer build completes (below), `dockerOrphanSweep` removes any
				// compose-project-labelled container that's NOT in this set —
				// those belong to primitives the user REMOVED from the config or
				// to a prior crashed process. Running the sweep AFTER the build
				// (instead of before) is what lets `Docker.run`'s adoption path
				// reuse a still-healthy `sui.localnet` from a previous process —
				// pre-build sweeping killed it unconditionally and forced a fresh
				// Sui genesis → new chain id → publishMove cache miss → NEW
				// packageId on every process restart.
				const claimedRef = yield* Ref.make<Set<string>>(new Set<string>());

				yield* engine.setHeader({
					app: headerApp,
					stack: headerStack,
					network: headerNetwork,
					buildStatus: cycle === 1 ? 'running' : 'restarting',
					cycle,
				});

				// Watch-driven selective restart (Phase 3) handles its
				// attribution inline at the watch fiber — the watch fiber
				// logs the cascade message and calls `invalidateSubset`
				// directly, without going through the full cycle restart.
				// User-driven `r` / SIGUSR2 land here on the next cycle but
				// carry no attribution by design (the user gesture is
				// "rebuild everything; I don't owe you a reason"). No
				// `changedTags` surface to clear or read.
				yield* engine.seedTags(seedEntries);

				// Build the full user stack as one composed Layer. Dependency
				// wiring relies on Effect's Layer runtime ordering — providers
				// complete before their consumers' acquires run. We catch any
				// acquire failure here so the TUI stays alive (red rows + log
				// entries) and `r` can trigger a full restart. The memoMap
				// holds bootstrap entries built once on longLivedScope, so the
				// user-stack layer's references to shared infra (EngineHandle,
				// StateStore, etc.) hit the cache instead of rebuilding.
				// `loggerLayer` is provided at the runOnce boundary below so
				// every `Effect.log*` inside the cycle (including the build's
				// own narration) gets routed into the TUI log panel.
				// Race the layer build against `awaitShutdown` so a `q`
				// press during acquire short-circuits the entire build
				// instead of blocking until the slowest primitive's
				// retry budget exhausts (sui ready-probe = 60s, walrus
				// genesis = 90s, etc.). Previously the supervisor only
				// consulted the shutdown signal AFTER the build returned
				// — so mid-startup `q` waited up to ~max(per-primitive
				// budget) before anything started tearing down. With
				// the race, shutdown wins → the build effect is
				// interrupted (Effect.race interrupts the losing branch
				// per Effect.ts docs), Layer's machinery rolls back the
				// primitives acquired so far on `supervisorScope`, and
				// teardown proceeds via the same scope-close path a
				// post-ready `q` uses.
				type BuildOutcome = 'ok' | 'failed' | 'interrupted';
				const buildOutcome: BuildOutcome = yield* Effect.race(
					Layer.buildWithMemoMap(
						userStackLayer as Layer.Layer<unknown, unknown, never>,
						memoMap,
						supervisorScope,
					).pipe(
						Effect.provideService(ClaimedContainers, claimedRef),
						Effect.as('ok' as const),
						Effect.catchCause((cause) => {
							const rendered = prettyError(cause);
							// Belt-and-braces: write the cause directly to stderr
							// so a CI fast-fail or a piped `pnpm dev > log`
							// invocation can see what failed. The plain
							// renderer's 500ms poll may not flush in time before
							// the fast-fail Effect.fail exits the process,
							// leaving the appendLog'd line stuck in the engine's
							// Ref. stderr write is synchronous.
							if (rendererKind !== 'tui') {
								process.stderr.write(`stack acquire failed:\n${rendered}\n`);
							}
							return engine
								.appendLog({
									ts: Date.now(),
									level: 'error',
									message: `stack acquire failed:\n${rendered}`,
								})
								.pipe(Effect.as('failed' as const));
						}),
					),
					engine.awaitShutdown.pipe(Effect.as('interrupted' as const)),
				);
				const buildSucceeded = buildOutcome === 'ok';

				// User-initiated shutdown mid-build: skip both the orphan
				// sweep (claimedRef is incomplete — sweeping would destroy
				// healthy containers from sibling stacks) AND the CI
				// fast-fail (a user `q` is not a stack failure). Return
				// cleanly so the launch loop exits and the outer
				// `Effect.scoped` tears down accumulated finalizers — the
				// `supervisorScope` finalizer (above) fires `invalidateAll`
				// concurrently with the layer-build cascade so any partial
				// docker stops still run in parallel.
				if (buildOutcome === 'interrupted') {
					yield* engine.setBuildStatus('shutting-down');
					return false;
				}

				// Post-build orphan sweep. Removes any compose-project-labelled
				// container that THIS process did NOT adopt-or-create during the
				// layer build — i.e. containers whose primitives were dropped
				// from the config, or that were left behind by a crashed prior
				// process. Restricted to cycle 1 so a watch-fire's targeted
				// invalidation (Phase 3) doesn't sweep a primitive that wasn't
				// in the invalidated set but also wasn't claimed this cycle.
				// Best-effort throughout.
				//
				// CRITICAL: only sweep on successful build. A failed build
				// (e.g. state-store locked by a sibling supervisor, primitive
				// failure mid-acquire) leaves `claimedRef` incomplete — sweeping
				// against it would destroy the sibling's healthy containers
				// because they look like "orphans" to this process. The
				// adopt-on-next-run path also relies on those containers
				// surviving, so a failed cycle MUST be a no-op against existing
				// docker state.
				if (cycle === 1 && buildSucceeded) {
					const claimed = yield* Ref.get(claimedRef);
					const swept = yield* dockerOrphanSweep(sweepApp, sweepStack, sweepNetwork, claimed).pipe(
						Effect.provide(PlatformLive as Layer.Layer<ChildProcessSpawner.ChildProcessSpawner>),
					);
					if (swept.length > 0) {
						yield* Effect.logInfo(
							`devstack: swept ${swept.length} orphan container(s) from prior run of ${sweepApp}/${sweepStack}/${sweepNetwork}`,
						);
					}
				}

				// CI fast-fail: in non-interactive renderers (`plain` /
				// `silent`), a first-cycle build failure should surface as
				// a non-zero process exit instead of blocking on the restart
				// signal forever — there's no user at the keyboard to press
				// `r`, and CI runners would otherwise hang until SIGTERM.
				// Interactive TUI mode keeps the wait-for-`r` behavior so a
				// developer can fix the config and retry without losing the
				// rendered failure tree.
				//
				// We fail AFTER the orphan sweep (above) so its `cycle === 1
				// && buildSucceeded` guard still skips the destructive path
				// — `buildSucceeded === false` here means we never touched
				// docker state. The bootstrap scope's finalizers (state-store
				// lock release, file-watcher cleanup) still run on the way
				// out because `Effect.fail` exits via the scoped supervisor.
				if (cycle === 1 && !buildSucceeded && rendererKind !== 'tui') {
					yield* engine.setBuildStatus('shutting-down');
					return yield* Effect.fail(
						new Error(
							'devstack: stack acquire failed on first cycle ' +
								`(renderer=${rendererKind}); exiting non-zero. See log above for the underlying cause.`,
						),
					);
				}

				yield* engine.setBuildStatus('running');

				// Block on the full-restart signal until the user presses r
				// (full restart), Shift+R, SIGUSR2, file watch, or Ctrl-C.
				// The queue absorbs any `requestRestart` that fires during
				// the teardown/setup gap before the next cycle's await —
				// no lost-wake-up race even when a producer fires between
				// take returning and the next take being scheduled.
				// Race restart vs shutdown. `r`-key (or watch trigger /
				// SIGUSR2) fires `requestRestart`; `q`-key fires
				// `requestShutdown` directly without going through SIGINT.
				// Whichever wins decides whether the launch loop iterates
				// or exits cleanly. Ctrl-C still works through
				// NodeRuntime.runMain's separate signal handler that
				// interrupts this fiber from outside.
				const reason = yield* Effect.race(
					engine.awaitRestart.pipe(Effect.as('restart' as const)),
					engine.awaitShutdown.pipe(Effect.as('shutdown' as const)),
				);
				if (reason === 'shutdown') {
					yield* engine.setBuildStatus('shutting-down');
					// `Effect.scoped` will close the per-cycle scope on return,
					// which cascades into supervisorScope's close (parallel
					// strategy). The `invalidateAll` finalizer registered above
					// fires concurrently with the Layer-build cascade, so every
					// primitive's `docker stop` runs in one parallel batch.
					return false;
				}
				yield* engine.setBuildStatus('restarting');
				return true;
			}).pipe(
				Effect.provide(loggerLayer as Layer.Layer<unknown, never, never>),
				Effect.scoped,
				Effect.withSpan('Devstack.launch'),
			);
		};

		return Effect.gen(function* () {
			// Capture the outer launch scope — lives for the entire
			// runMain lifetime, only torn down on Ctrl-C / process exit.
			// Bootstrap (engine + StateStore + Identity + watchers +
			// SIGUSR2 + traefik) lives here so they survive `r` (which
			// only tears the per-cycle scope down) — pre-C4 the bootstrap
			// was acquired on the per-cycle scope, so every `r` re-opened
			// the state.json.lock + re-mounted watcher fibers +
			// re-installed the SIGUSR2 handler, plus the StateStore lock
			// briefly released between cycles and let a sibling supervisor
			// in. Per Phase 2 of selective-restart, user-stack primitives
			// build against the per-cycle supervisorScope (each Layer's
			// own scope forked by Effect's MemoMap) — `r` cascades through
			// every primitive in the stack; selective watch-fires release
			// only the affected primitives' scopes.
			// Fork a parallel-finalizer child of the ambient (runMain) scope.
			// Effect's default `Scope` runs finalizers SEQUENTIALLY at
			// teardown — with 6+ long-lived containers each carrying a
			// `docker stop --time N` finalizer (sui=30s, indexer-db=20s,
			// walrus×4=20s each, seal=15s), serial teardown is ~145s in
			// the worst case. That matched the user's "shutdown still
			// isn't working" / "still timing out" perception perfectly:
			// each `markStopping` fired only AFTER the previous container's
			// docker-stop completed, so the TUI showed exactly one row
			// transition every 20–30s.
			//
			// "parallel" runs all registered finalizers concurrently — net
			// teardown drops from ~sum(grace) to ~max(grace) (~30s for a
			// healthy stack, even less when sui exits cleanly within the
			// grace window). Order-sensitive finalizers (state-store lock
			// release, ink unmount, bootstrap teardown) are individually
			// `Effect.uninterruptible` so they still complete-or-not as
			// units; parallel just removes the serial-blocking between
			// finalizers that don't depend on each other.
			const ambient = yield* Effect.scope;
			const longLived = yield* Scope.fork(ambient, 'parallel');

			// Single MemoMap held for the supervisor's lifetime. The
			// bootstrap layer's entries are built into it once on
			// `longLived`; per-cycle `runOnce` calls
			// `Layer.buildWithMemoMap(userStackLayer, memoMap, supervisorScope)`
			// which reuses the cached bootstrap entries and builds the
			// user-stack entries fresh on the per-cycle scope.
			const memoMap = yield* Layer.makeMemoMap;

			const bootstrapCtx = yield* Layer.buildWithMemoMap(bootstrapLayer, memoMap, longLived);
			const engine: EngineShape = Context.get(bootstrapCtx, EngineHandle);
			const registry = Context.get(bootstrapCtx, Registry);

			// Registry announce + clearPid finalizer — both belong on the
			// long-lived scope so a `pnpm dev` whose lock survived a
			// crashed cycle still tells `devstack doctor` we're alive.
			const registryNetwork: RegistryNetwork = headerNetwork;
			const registryRepoPath = resolveAppDir();
			yield* registry
				.upsert({
					app: headerApp,
					stack: headerStack,
					network: registryNetwork,
					repoPath: registryRepoPath,
					pid: process.pid,
				})
				.pipe(Effect.ignore);
			yield* Effect.addFinalizer(() =>
				registry.clearPid(headerApp, headerStack, registryNetwork).pipe(Effect.ignore),
			);

			// Ensure the shared Traefik router is up BEFORE any
			// primitive starts, ONCE for the whole supervisor lifetime.
			// Memoizing here removes the per-cycle ensure-router cost on
			// `r` (the previous per-cycle ensure was a no-op against a
			// healthy traefik, but still cost a `docker inspect`).
			if (process.env.DEVSTACK_NO_ROUTER !== '1') {
				yield* ensureRouter.pipe(
					Effect.provide(bootstrapCtx),
					Effect.timeoutOrElse({
						duration: '10 seconds',
						orElse: () =>
							Effect.logWarning(
								'devstack: traefik router boot timed out after 10s — continuing without it',
							),
					}),
					Effect.catch((cause) =>
						Effect.logWarning(
							`devstack: traefik router boot failed: ${(cause as { message?: string })?.message ?? String(cause)} — falling back to direct ports for any traefik-aware primitives`,
						),
					),
				);
			}

			// Mount the renderer ONCE for the entire runMain lifetime.
			// Both ink (TUI) and the plain renderer fork live on the
			// outer `longLived` scope so they survive `r` / file-watch
			// cycles instead of being torn down between cycles. The
			// per-cycle `install(engine)` swaps the cycle's engine into
			// the (stable) renderer proxy — for ink this redirects the
			// ink components' reads + `r`-keypress restarts; for plain /
			// silent it's a no-op (the renderer reads `engine.tuiState`
			// directly).
			//
			// `flush` is captured so the `onInterrupt` path can drive
			// ONE explicit render of the final 'shutting-down' state
			// BEFORE docker-rm finalizers freeze the event loop
			// (replaces the previous arbitrary `Effect.sleep('150
			// millis')`, which could miss the plain renderer's 500ms
			// tick).
			const rendererMount = yield* rendererFactory
				.mount({ tuiStateRef: engine.tuiState })
				.pipe(Effect.provide(bootstrapCtx));
			yield* rendererMount.install(engine);
			const rendererFlush = rendererMount.flush;

			// SIGUSR2 handler + watcher fibers on longLived too (HIGH-S1).
			// The engine they target is stable, so the per-cycle re-install
			// was just churn; worse, the per-cycle install + scope-finalizer
			// detach meant a SIGUSR2 arriving between cycles could land on
			// no handler and the process would die from the default action.
			yield* installSignalRestart('SIGUSR2', engine);
			if (watchRoots.length > 0) {
				// Wire the static downstream closure (computed once at compose
				// time from the dep graph in Phase 1) into every watch fiber.
				// Lights up the cascade enumeration in `formatRestartCascade`
				// (Phase 5) and the heavy-infra reboot-cost warning. Phase 3
				// uses the same closure to drive `engine.invalidateSubset`.
				for (const root of watchRoots) {
					yield* watchPathFiber(
						root,
						engine,
						hotRestart,
						watchOwners,
						watchFilter,
						downstreamClosure,
					).pipe(Effect.provide(bootstrapCtx));
				}
			}

			const launchLoop = Effect.gen(function* () {
				let cycle = 0;
				while (true) {
					cycle += 1;
					const again = yield* runOnce(cycle, engine, memoMap);
					if (!again) return;
				}
			});

			// `Effect.onInterrupt` runs synchronously BEFORE scope teardown
			// continues — that's the only window where the engine and the
			// renderer (ink or plain) are still alive. Flip the build-status,
			// post the teardown log line, then explicitly drive ONE renderer
			// flush so the final 'shutting-down' state is on screen BEFORE
			// the docker-rm finalizers freeze the event loop.
			//
			// Pre-fix: a fixed `Effect.sleep('150 millis')`. Worked for ink
			// (50ms poll, three chances to catch the state) but plain's
			// 500ms tick could miss it entirely on a tick boundary.
			// The explicit flush is bounded, scoped to the active renderer,
			// and free when no renderer is attached (silent default `Effect.void`).
			yield* launchLoop.pipe(
				Effect.onInterrupt(() =>
					Effect.gen(function* () {
						yield* engine.setBuildStatus('shutting-down');
						yield* engine.appendLog({
							ts: Date.now(),
							level: 'info',
							message: SHUTDOWN_LOG_MESSAGE,
						});
						yield* rendererFlush;
						// Parallel `invalidateAll` is wired through
						// `supervisorScope`'s finalizer inside `runOnce` (see
						// `Scope.addFinalizer(supervisorScope, …)` above) so
						// it fires concurrently with the layer-build cascade.
						// We DON'T call it again here — by the time this
						// onInterrupt runs, `runOnce`'s `Effect.scoped`
						// cascade has already started and the finalizer is
						// firing in parallel with it.
					}),
				),
			);
		}).pipe(Effect.scoped);
	};

	return {
		layer: fullLayer,
		config,
		launchEffect: (overrides = {}) => buildLaunchEffect(overrides),
		run: (overrides = {}) => Effect.runPromise(buildLaunchEffect(overrides)).then(() => undefined),
		runMain: (overrides = {}) => nodeRunMain(buildLaunchEffect(overrides)),
	};
};
