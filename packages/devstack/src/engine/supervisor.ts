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
import { Context, Deferred, Effect, Layer, Ref, Stream } from 'effect';
import { layer as NodeServicesLayer } from '@effect/platform-node/NodeServices';
import { runMain as nodeRunMain } from '@effect/platform-node/NodeRuntime';
import { ChildProcessSpawner } from 'effect/unstable/process';
import { ClaimedContainers, dockerOrphanSweep, ensureRouter } from './docker.js';
import { prettyError } from './pretty-error.js';
import { LongLivedScope } from './long-lived-scope.js';
import {
	EngineHandle,
	EngineLive,
	EndpointRegistryWithEngineLive,
	type EngineHandleShape,
} from './engine.js';
import { FileWatcher, FileWatcherLive } from './file-watcher.js';
import { Identity, deriveAppName } from './identity.js';
import { LeasingLive } from './leasing.js';
import { registry, type RegistryNetwork } from './registry.js';
import { PortAllocatorLive } from './port-allocator.js';
import {
	AccountRegistryLive,
	CoinRegistryLive,
	PackageRegistryLive,
} from './registries.js';
import { StateStoreConfig, StateStoreLive } from './state-store.js';
import type { SuiNetwork } from '../services/sui.js';
import type { TagKind } from '../advanced/tag.js';
import { startPlainRenderer } from '../tui/plain.js';
import { SHUTDOWN_LOG_MESSAGE, startTuiOnce, TuiLoggerLayer, type TuiMount } from '../tui/index.js';

// Structural shape of a stack member — anything carrying `__layer` (or
// a flattened `__layers` for composites). Once Phase 3b finishes
// inlining primitives, every entry in `config.stack` is a substrate
// `Ref<...>` and this alias collapses; for now it survives because the
// primitives' hand-rolled returns (`walrusLocalCluster`, `sealLocalKeygen`,
// …) carry `{__layer, __layers, key}` directly without going through
// `tag`/`provide`/`composeTag`, so they don't satisfy `Ref`'s
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
}

export type RendererKind = 'tui' | 'plain' | 'silent';

export interface DevstackConfig {
	readonly stack: ReadonlyArray<StackMember>;
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
	 */
	readonly renderer?: RendererKind;
	/**
	 * @deprecated Prefer `renderer`. `tui: true` maps to `renderer: 'tui'`
	 * and `tui: false` maps to `renderer: 'plain'`. When both are set,
	 * `renderer` wins.
	 */
	readonly tui?: boolean;
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
	 * the legacy log-only behavior for `watch` users who don't want
	 * teardown-on-edit.
	 */
	readonly hotRestart?: boolean;
}

const resolveRenderer = (config: DevstackConfig): RendererKind => {
	if (config.renderer !== undefined) return config.renderer;
	if (config.tui !== undefined) return config.tui ? 'tui' : 'plain';
	return process.stdout.isTTY === true ? 'tui' : 'plain';
};

/** Overrides applied at `run()` time, layered on top of `DevstackConfig`. */
export interface RunOverrides {
	readonly renderer?: RendererKind;
}

export interface Devstack {
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
		PortAllocatorLive,
		LeasingLive,
		FileWatcherLive,
	),
);

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
const composeBootstrapLayer = (
	opts: StackComposeOptions = {},
): Layer.Layer<unknown, unknown, never> => {
	const stateStoreConfig: {
		readonly stack: string;
		readonly network: SuiNetwork;
		readonly stateDir?: string;
	} = {
		stack: resolveStackName(opts.stackName),
		network: opts.network ?? 'localnet',
		...(opts.stateDir !== undefined ? { stateDir: opts.stateDir } : {}),
	};
	const StateStoreConfigLive = Layer.succeed(StateStoreConfig, stateStoreConfig);
	// `Layer.provideMerge` (not `provide`) re-exports `StateStoreConfig`
	// from the resulting layer so user primitives can still
	// `yield* StateStoreConfig` from inside their build body.
	const StateStoreFullLive = Layer.provideMerge(StateStoreLive, StateStoreConfigLive);
	const IdentityLive = Layer.succeed(Identity, {
		app: deriveAppName(),
		stack: stateStoreConfig.stack,
		network: stateStoreConfig.network,
	});
	const platform: Layer.Layer<unknown, unknown, never> =
		opts.platformLayer ?? (NodeServicesLayer as Layer.Layer<unknown, unknown, never>);
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
	);
	return Layer.provideMerge(bootstrapCore, platform) as Layer.Layer<unknown, unknown, never>;
};

type EngineShape = EngineHandleShape;

// Process-level signal listener that drives a restart. Installed inside
// the per-iteration scope so the finalizer removes it on teardown — a
// stale listener pointing at a torn-down engine would otherwise no-op
// silently after a hot-restart cycle.
//
// Effect v4 doesn't expose POSIX signal handling in core or
// `@effect/platform-node` (only SIGINT/SIGTERM are wired into
// `NodeRuntime.runMain` internally). So we keep the raw `process.on`
// for SIGUSR2 plus a scope finalizer to detach. If a future Effect API
// surfaces signal streams, this becomes a one-line swap.
const installSignalRestart = (
	signal: NodeJS.Signals,
	engine: EngineShape,
): Effect.Effect<void, never, import('effect/Scope').Scope> =>
	Effect.gen(function* () {
		const handler = () => {
			// Fire-and-forget: the Deferred holds the cross-fiber connection,
			// so we don't need to await runtime resolution here.
			Effect.runFork(engine.requestRestart);
		};
		process.on(signal, handler);
		yield* Effect.addFinalizer(() =>
			Effect.sync(() => {
				process.off(signal, handler);
			}),
		);
	});

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
// what triggered the restart" and (b) propagate the changed keys forward
// via `engine.notifyChangedTags` for downstream diagnostics. A single
// path may have multiple owners (two primitives watching overlapping
// directories), so attribution is a `ReadonlyArray`.
export interface WatchOwner {
	readonly key: string;
	readonly title: string;
	readonly absolutePath: string;
}

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

// File-watcher fiber. When `hotRestart` is on, events are debounced 250ms
// and the trailing edge signals the engine; coalescing avoids tearing the
// stack down once per character of a multi-keystroke save. Otherwise we
// just log so users see the wiring is alive.
const watchPathFiber = (
	path: string,
	engine: EngineShape,
	hotRestart: boolean,
	owners: ReadonlyArray<WatchOwner>,
): Effect.Effect<void, never, FileWatcher | import('effect/Scope').Scope> =>
	Effect.gen(function* () {
		const watcher = yield* FileWatcher;
		const stream = watcher.watch(path);
		const drained = hotRestart
			? Stream.runForEach(stream.pipe(Stream.debounce('250 millis')), (event) =>
					Effect.gen(function* () {
						const { changed, reason } = yield* hashFileIfChanged(event.path);
						if (!changed) {
							yield* Effect.logDebug(
								`file change at ${event.path} ignored (${reason})`,
							);
							return;
						}
						// Attribution: resolve the changed path back to the
						// primitives that declared it. Bare `config.watch`
						// entries surface as "(unowned)" — the restart still
						// fires, the diagnostic just notes the trigger wasn't
						// associated with any specific primitive.
						const matched = ownersFor(event.path, owners);
						if (matched.length > 0) {
							const labels = matched.map((o) => o.title).join(', ');
							yield* Effect.logInfo(
								`file change at ${event.path} (kind=${event.kind}, ${reason}) ` +
									`— owned by ${labels} — restarting`,
							);
							yield* engine.notifyChangedTags(matched.map((o) => o.key));
						} else {
							yield* Effect.logInfo(
								`file change at ${event.path} (kind=${event.kind}, ${reason}) ` +
									`— unowned watch path — restarting`,
							);
						}
						yield* engine.requestRestart;
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
 * runner-side TUI / watcher knobs). Used by both `defineDevstack` and
 * `provideDevstack` so the latter can reuse the composition step without
 * dragging in the run-loop surface.
 */
export interface StackComposeOptions {
	readonly stackName?: string;
	readonly network?: SuiNetwork;
	readonly stateDir?: string;
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
 * Compose JUST the infra+platform half of the devstack graph (registries,
 * engine, state store, identity, Node platform services). The result has
 * `RIn = never` and `ROut = unknown` — everything user-stack primitives
 * may consume. Per-primitive launch loops (`defineDevstack.runOnce`)
 * build this once at the supervisor scope and reuse it as the seed
 * Context for every per-primitive child scope, so a primitive failure
 * only tears down ITS resources (not the shared infra).
 *
 * `provideDevstack` and `composeStackLayer` continue to build a single
 * fused layer including the user stack; this helper is only needed when
 * the caller wants to fork user-stack acquisition into per-primitive
 * child scopes.
 */
export const composeInfraLayer = (
	opts: StackComposeOptions = {},
): Layer.Layer<unknown, unknown, never> => {
	const stateStoreConfig: {
		readonly stack: string;
		readonly network: SuiNetwork;
		readonly stateDir?: string;
	} = {
		stack: resolveStackName(opts.stackName),
		network: opts.network ?? 'localnet',
		...(opts.stateDir !== undefined ? { stateDir: opts.stateDir } : {}),
	};
	const StateStoreConfigLive = Layer.succeed(StateStoreConfig, stateStoreConfig);
	const StateStoreFullLive = Layer.provideMerge(StateStoreLive, StateStoreConfigLive);
	const IdentityLive = Layer.succeed(Identity, {
		app: deriveAppName(),
		stack: stateStoreConfig.stack,
		network: stateStoreConfig.network,
	});
	// `infraOverrides` (when set) is merged LAST so `Layer.mergeAll`'s
	// later-wins semantics shadow any duplicate tag in `InfraLiveCore`
	// (e.g. a deterministic `PortAllocator` for integration tests).
	const InfraLive =
		opts.infraOverrides !== undefined
			? Layer.mergeAll(
					InfraLiveCore,
					StateStoreFullLive,
					IdentityLive,
					opts.infraOverrides as Layer.Layer<any, any, any>,
				)
			: Layer.mergeAll(InfraLiveCore, StateStoreFullLive, IdentityLive);
	// `platformLayer` accepts a `Layer<unknown,…>` (the "strongest layer"
	// interpretation — provides ALL services). The default `PlatformLive`
	// is a narrower `Layer<NodeServices,…>`; we cast to the wider shape
	// since callers consume the composed layer via `Context.get(tag)` at
	// runtime and accept ServiceNotFound for absent tags. Going through
	// the same widening type as `platformLayer` (not `Layer<any,any,any>`)
	// keeps E + RIn precise.
	const platform: Layer.Layer<unknown, unknown, never> =
		opts.platformLayer ?? (PlatformLive as Layer.Layer<unknown, unknown, never>);
	return Layer.provideMerge(InfraLive, platform) as Layer.Layer<unknown, unknown, never>;
};

/**
 * Compose a user-supplied `stack` into the fully-resolved Devstack
 * Layer: every tag's `__layer(s)` merged together, then wrapped with
 * infrastructure (engine, registries, state store, identity) and
 * platform (Node FileSystem / Path / ChildProcessSpawner / Stdio /
 * Terminal) layers. Returned as `Layer<unknown, unknown, never>` because
 * each primitive contributes its own service / error vocabulary; the
 * caller resolves services from Context at runtime.
 *
 * Shared between `defineDevstack` (which wraps the result in a launch
 * loop) and `provideDevstack` (which hands it straight to
 * `Effect.provide`).
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
			Effect.runSync(
				Effect.logWarning(
					`Devstack: duplicate service detected: ${key}. Last one wins. Composing two implementations of the same interface (e.g. both suiLocalnet() and suiTestnet()) is almost certainly a bug.`,
				),
			);
		}
		seenKeys.add(key);
	}

	// Prefer `__layers` (transitively-flattened) when a composite tag
	// supplies it; fall back to the single `__layer` for tags built via
	// the legacy `tag(name, build)` shape or the hand-rolled `Sui`
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

	// Per-devstack state-store identity. Reads from config with sane
	// defaults, then provides itself as a Layer so StateStoreLive can
	// `yield* StateStoreConfig` to compute the path.
	const stateStoreConfig: {
		readonly stack: string;
		readonly network: SuiNetwork;
		readonly stateDir?: string;
	} = {
		stack: resolveStackName(opts.stackName),
		network: opts.network ?? 'localnet',
		...(opts.stateDir !== undefined ? { stateDir: opts.stateDir } : {}),
	};
	const StateStoreConfigLive = Layer.succeed(StateStoreConfig, stateStoreConfig);
	// `Layer.provideMerge` (not `provide`) re-exports `StateStoreConfig`
	// from the resulting layer so user primitives (e.g. `accounts`'s
	// `ephemeral-funded` branch resolving the on-disk keystore path) can
	// `yield* StateStoreConfig` inside their body. A plain `Layer.provide`
	// hides the config, and the acquire body fails with `ServiceNotFound:
	// @devstack/StateStoreConfig` — silent until a user-facing primitive
	// happens to consume it.
	const StateStoreFullLive = Layer.provideMerge(StateStoreLive, StateStoreConfigLive);
	// `Identity` flows the resolved `<app, stack, network>` triple into
	// `Docker.run` so every container we launch gets stamped with
	// `--label devstack.app=... --label devstack.stack=... --label
	// devstack.action=...` and so the container/compose-project name
	// includes the network suffix on non-localnet (preventing collisions
	// when the same `<app, stack>` runs against testnet AND localnet).
	// `wipe` / `stack down` filter on these labels.
	const IdentityLive = Layer.succeed(Identity, {
		app: deriveAppName(),
		stack: stateStoreConfig.stack,
		network: stateStoreConfig.network,
	});
	// `infraOverrides` (when set) is merged LAST so `Layer.mergeAll`'s
	// later-wins semantics shadow any duplicate tag in `InfraLiveCore`
	// (e.g. a deterministic `PortAllocator` for integration tests).
	const InfraLive =
		opts.infraOverrides !== undefined
			? Layer.mergeAll(
					InfraLiveCore,
					StateStoreFullLive,
					IdentityLive,
					opts.infraOverrides as Layer.Layer<any, any, any>,
				)
			: Layer.mergeAll(InfraLiveCore, StateStoreFullLive, IdentityLive);

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
	// code that provides `fullLayer` directly (e.g. provideDevstack),
	// would both ServiceNotFound at runtime. provideMerge keeps the
	// internal wiring intact while still re-exporting upward.
	const withInfra = Layer.provideMerge(userLayer, InfraLive);
	// See `composeInfraLayer`: platformLayer is typed as the widest
	// `Layer<unknown,…>` shape because the caller resolves services from
	// the composed layer via `Context.get(tag)` at runtime. PlatformLive
	// narrows to NodeServices; the cast widens (no `any` round-trip).
	const platform: Layer.Layer<unknown, unknown, never> =
		opts.platformLayer ?? (PlatformLive as Layer.Layer<unknown, unknown, never>);
	const fullLayer = Layer.provideMerge(withInfra, platform);
	return fullLayer as Layer.Layer<unknown, unknown, never>;
};

export const defineDevstack = (input: ReadonlyArray<StackMember> | DevstackConfig): Devstack => {
	const config: DevstackConfig = Array.isArray(input)
		? { stack: input }
		: (input as DevstackConfig);

	const fullLayer = composeStackLayer(config.stack, {
		stackName: config.stackName,
		network: config.network,
		stateDir: config.stateDir,
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
	}> = config.stack.map((m, i) => {
		const key = (m as { key?: string }).key ?? `stack[${i}]`;
		const kind = (m as { __kind?: TagKind }).__kind;
		const title = (m as { __displayTitle?: string }).__displayTitle;
		const entry: { key: string; kind?: TagKind; title?: string } = { key };
		if (kind !== undefined) entry.kind = kind;
		if (title !== undefined) entry.title = title;
		return entry;
	});

	// Watch set = explicit `config.watch` plus every primitive that
	// declared paths via `provide({watch})` / `tag({watch})`.
	// `publishMove` uses this to auto-watch its Move source tree so a
	// `.move` edit triggers a hot-restart (which cascades through
	// `bindings` regen + frontend HMR) without the user having to repeat
	// the Move path in `config.watch`. De-dupe so a path that appears in
	// both config.watch and a primitive's `__watchPaths` doesn't get two
	// fs.watch handles.
	//
	// `watchOwners` carries the reverse index — for each
	// primitive-declared path, who declared it. Used by the watcher fiber
	// to attribute file-change events back to their owning primitive and
	// log diagnostic output ("publishMove(hello) — restarting"). Paths
	// from `config.watch` are deliberately NOT in `watchOwners` — they
	// surface in the diagnostic as "unowned watch path" so the user can
	// tell at a glance whether the restart came from a primitive's
	// declared input or from a config-level catch-all path. Selective
	// per-primitive Layer-cache invalidation (so unchanged primitives
	// skip their build effect across cycles) requires Effect MemoMap
	// surgery that isn't appropriate to attempt in-session — the
	// attribution surface here is the foundation that the future
	// implementation will key on.
	const watchOwners: ReadonlyArray<WatchOwner> = config.stack.flatMap((m, i) => {
		const paths = (m as { __watchPaths?: ReadonlyArray<string> }).__watchPaths ?? [];
		if (paths.length === 0) return [];
		const key = (m as { key?: string }).key ?? `stack[${i}]`;
		const title = (m as { __displayTitle?: string }).__displayTitle ?? key;
		return paths.map((p) => ({
			key,
			title,
			absolutePath: nodePath.resolve(process.cwd(), p),
		}));
	});
	const aggregatedPrimitiveWatch = watchOwners.map((o) => o.absolutePath);
	const watchPaths = Array.from(new Set([...(config.watch ?? []), ...aggregatedPrimitiveWatch]));
	// `hotRestart` only governs FILE-WATCH-driven restarts. User-driven
	// restarts (TUI `r` key, SIGUSR2) ALWAYS recycle — pressing `r` is the
	// explicit "I want to restart" gesture and would be inexplicable if the
	// flag silently turned it into a quit.
	const hotRestart = config.hotRestart ?? watchPaths.length > 0;

	const headerApp = deriveAppName();
	const headerStack = resolveStackName(config.stackName);
	const headerNetwork = config.network ?? 'localnet';

	// Bootstrap layer for the supervisor: engine + filewatcher + platform
	// + state-store + identity. Built once per `defineDevstack` so the
	// state-store lock identity (path + instanceId derived inside its
	// build body) stays consistent across cycles. Memo-map sharing between
	// bootstrap and the user-stack build means a second StateStore acquire
	// (via composeStackLayer's redundant wiring, kept for the
	// provideDevstack path) is a memoised no-op — only one lock-file write
	// per supervisor.
	const bootstrapLayer = composeBootstrapLayer({
		stackName: config.stackName,
		network: config.network,
		stateDir: config.stateDir,
	});

	const buildLaunchEffect = (overrides: RunOverrides): Effect.Effect<void, unknown, never> => {
		const renderer = overrides.renderer ?? resolveRenderer(config);

		// Single iteration. Per-primitive scope topology:
		//
		//   supervisorScope ── runOnce's own Effect.scoped scope
		//     │
		//     ├── infraCtx        (registries, engine, state-store,
		//     │                    identity, platform) — built once, lives
		//     │                    for the whole iteration; tears down on
		//     │                    full restart or Ctrl-C
		//     │
		//     ├── childScope[A]   (Sui)            ─┐
		//     ├── childScope[B]   (accountAlice)    ├─ each forked off
		//     ├── childScope[C]   (publishMove)     │  supervisorScope;
		//     ├── …                                 ┘  closes on per-
		//     │                                        primitive failure
		//     │                                        or retry-cycle
		//     │
		//     └── restart-await fiber — blocks on the engine's restart
		//                               signal; returns from runOnce
		//                               (which tears the supervisor scope
		//                               down for a full restart cycle)
		//
		// Per-primitive failures only collapse the relevant childScope,
		// leaving the supervisor and sibling primitives running. The user
		// sees the failed row stay red, presses `r`, and a fresh
		// childScope re-runs that primitive's acquire — siblings stay
		// green throughout.
		const runOnce = (
			cycle: number,
			tuiMount: TuiMount | undefined,
			currentEngineRef: Ref.Ref<EngineHandleShape | undefined>,
		) =>
			Effect.gen(function* () {
				// Fresh MemoMap per iteration so every restart re-evaluates the
				// infra Live layers. Shared across the bootstrap and infra
				// builds so EngineHandle / StateStore / etc. are the SAME
				// instance the per-primitive fibers consume.
				const memoMap = yield* Layer.makeMemoMap;
				const supervisorScope = yield* Effect.scope;

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

				// Bootstrap engine + file watcher + platform + StateStore +
				// Identity. This is the supervisor's resource pool — stays
				// alive for the entire iteration, surviving per-primitive
				// failures. The state-store acquire fires HERE (its build is
				// what opens `state.json.lock` via O_EXCL), so a competing
				// supervisor on the same <stack, network> fails loudly via
				// `StateStoreLockedError` BEFORE we touch docker. Per-
				// primitive fibers Effect.provideContext(bootstrapCtx ⊕
				// infraCtx) so they can `yield* EngineHandle` / `yield*
				// StateStore` / etc.
				const bootstrapCtx = yield* Layer.buildWithMemoMap(
					bootstrapLayer,
					memoMap,
					supervisorScope,
				);
				const engine: EngineShape = Context.get(bootstrapCtx, EngineHandle);

				// Ensure the shared Traefik router is up BEFORE any
				// primitive starts. The router is the cross-stack
				// reverse-proxy that binds the well-known host ports
				// (9000 sui-rpc, 9123 faucet, 9185 walrus, etc.) and
				// dispatches by Host header to per-stack backends.
				// Idempotent: skipped if a healthy traefik is already
				// running. Best-effort: a failure here logs a warning
				// and continues — primitives that don't opt into the
				// `traefik` label set still work over direct ports.
				// `DEVSTACK_NO_ROUTER=1` skips traefik boot entirely —
				// used by unit tests that don't go through docker,
				// and as an emergency switch for users that don't
				// want the shared router. Capped at 10s so a docker
				// daemon hang doesn't block the supervisor.
				if (process.env.DEVSTACK_NO_ROUTER !== '1') {
					yield* (
						ensureRouter.pipe(
							Effect.provide(bootstrapCtx as any),
							Effect.timeoutOrElse({
								duration: '10 seconds',
								orElse: () =>
									Effect.logWarning(
										'devstack: traefik router boot timed out after 10s — continuing without it',
									),
							}),
							Effect.catch((cause: any) =>
								Effect.logWarning(
									`devstack: traefik router boot failed: ${(cause as { message?: string })?.message ?? String(cause)} — falling back to direct ports for any traefik-aware primitives`,
								),
							),
						) as Effect.Effect<void, never, never>
					);
				}

				// Best-effort: announce ourselves to the global registry so
				// `devstack doctor` / `devstack prune` on any host shell can
				// see this (app, stack, network) even from inside a different
				// cwd — and, more importantly, still see it AFTER the repo
				// gets `rm -rf`'d. The registry I/O is wrapped in
				// `Effect.ignore` so a corrupt / locked registry file never
				// blocks supervisor boot. The scope finalizer below clears
				// our pid on clean shutdown so post-mortem `classify` drops
				// us out of the `active` bucket without us having to be
				// alive to write again.
				const registryNetwork: RegistryNetwork = headerNetwork;
				const registryRepoPath = process.env.DEVSTACK_APP_DIR ?? process.cwd();
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

				// Publish this cycle's engine to the outer launch effect so an
				// `Effect.onInterrupt` over there can flip `buildStatus` to
				// `shutting-down` + append the user-facing teardown log line on
				// SIGINT from outside the TUI (terminal Ctrl-C, external kill).
				// Cleared on cycle teardown so a between-cycle interrupt doesn't
				// poke a stale engine — currentRef stays undefined until the next
				// cycle's bootstrap completes.
				yield* Ref.set(currentEngineRef, engine);
				yield* Effect.addFinalizer(() => Ref.set(currentEngineRef, undefined));

				yield* engine.setHeader({
					app: headerApp,
					stack: headerStack,
					network: headerNetwork,
					buildStatus: cycle === 1 ? 'running' : 'restarting',
					cycle,
				});

				// Diagnostic surface: which primitive(s) triggered this
				// restart, if any. Populated by the watcher fiber before it
				// fired `requestRestart`. Cleared by `resetRestartSignal`
				// below, so this is the only point in the cycle where the
				// attribution from the previous cycle's trigger is still
				// readable. Empty on cycle 1 (no prior trigger) and on
				// user-driven restarts (TUI `r`, SIGUSR2) since those skip
				// `notifyChangedTags`. Surfaced as a log line rather than a
				// TUI section to keep the dashboard layout unchanged; the
				// TUI watcher will pick this up if/when selective per-
				// primitive Layer-cache invalidation lands and the row's
				// rebuild status needs to be differentiated from a clean-
				// slate acquire.
				if (cycle > 1) {
					const triggers = yield* Ref.get(engine.changedTags);
					if (triggers.length > 0) {
						yield* Effect.logInfo(
							`devstack cycle ${cycle} triggered by ${triggers.join(', ')}`,
						);
					}
				}

				yield* engine.resetRestartSignal;
				yield* engine.seedTags(seedEntries);

				// Re-point the long-lived ink mount at this cycle's fresh engine.
				// MUST happen AFTER seedTags so the proxy's first eager snapshot
				// already carries the new cycle's pending rows — without that the
				// user would see a frame of empty state between the old cycle's
				// terminal statuses and the new cycle's seeded rows. The plain
				// renderer is rebuilt each cycle: it's a one-line-per-event
				// stream, no layout state to preserve across cycles.
				if (renderer === 'tui' && tuiMount !== undefined) {
					yield* tuiMount.install(engine);
				} else if (renderer === 'plain') {
					const tuiSource = Ref.get(engine.tuiState);
					yield* startPlainRenderer(tuiSource).pipe(Effect.provide(bootstrapCtx));
				}

				const loggerLayer = renderer === 'tui' ? TuiLoggerLayer(engine) : Layer.empty;

				yield* installSignalRestart('SIGUSR2', engine);

				if (watchPaths.length > 0) {
					for (const path of watchPaths) {
						yield* watchPathFiber(path, engine, hotRestart, watchOwners).pipe(
							Effect.provide(bootstrapCtx),
						);
					}
				}

				// Build the full user stack as one composed Layer. Dependency
				// wiring relies on Effect's Layer runtime ordering — providers
				// complete before their consumers' acquires run. We catch any
				// acquire failure here so the TUI stays alive (red rows + log
				// entries) and `r` can trigger a full restart.
				const userStackLayer = composeStackLayer(config.stack, {
					stackName: config.stackName,
					network: config.network,
					stateDir: config.stateDir,
					platformLayer: undefined,
				});
				const buildSucceeded = yield* Layer.buildWithMemoMap(
					userStackLayer as Layer.Layer<unknown, unknown, never>,
					memoMap,
					supervisorScope,
				).pipe(
					Effect.provide(loggerLayer as Layer.Layer<unknown, never, never>),
					Effect.provideService(ClaimedContainers, claimedRef),
					Effect.as(true),
					Effect.catchCause((cause) => {
						const rendered = prettyError(cause);
						// Belt-and-braces: write the cause directly to stderr so a
						// CI fast-fail or a piped `pnpm dev > log` invocation can
						// see what failed. The plain renderer's 500ms poll may
						// not flush in time before the fast-fail Effect.fail
						// exits the process, leaving the appendLog'd line stuck
						// in the engine's Ref. stderr write is synchronous.
						if (renderer !== 'tui') {
							process.stderr.write(`stack acquire failed:\n${rendered}\n`);
						}
						return engine
							.appendLog({
								ts: Date.now(),
								level: 'error',
								message: `stack acquire failed:\n${rendered}`,
							})
							.pipe(Effect.as(false));
					}),
				);

				// Post-build orphan sweep. Removes any compose-project-labelled
				// container that THIS process did NOT adopt-or-create during the
				// layer build — i.e. containers whose primitives were dropped
				// from the config, or that were left behind by a crashed prior
				// process. Skipping this on later cycles (`r`) keeps long-lived
				// containers from being reaped between cycles when their
				// finalizer lives on `LongLivedScope`. Best-effort throughout.
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
				if (cycle === 1 && !buildSucceeded && renderer !== 'tui') {
					yield* engine.setBuildStatus('shutting-down');
					return yield* Effect.fail(
						new Error(
							'devstack: stack acquire failed on first cycle ' +
								`(renderer=${renderer}); exiting non-zero. See log above for the underlying cause.`,
						),
					);
				}

				yield* engine.setBuildStatus('running');

				// Block on the full-restart signal until the user presses r
				// (full restart), Shift+R, SIGUSR2, file watch, or Ctrl-C.
				const signal = yield* Ref.get(engine.restartSignal);
				yield* Deferred.await(signal);
				yield* engine.setBuildStatus('restarting');
				return true;
			}).pipe(Effect.scoped, Effect.withSpan('Devstack.launch'));

		return Effect.gen(function* () {
			// Capture the outer launch scope — lives for the entire
			// runMain lifetime, only torn down on Ctrl-C / process exit.
			// Provided to `runOnce` as `LongLivedScope` so reusable docker
			// containers (Sui, indexer-db, walrus) register their
			// `docker rm -f` finalizer here instead of the per-cycle
			// supervisor scope. Result: `r` (which only tears the
			// per-cycle scope down) leaves containers running, the
			// reuse-if-healthy probe in `Docker.run` finds them on the
			// next iteration, chain id stays stable, publishMove cache
			// hits, packageIds stay stable across restarts.
			const longLived = yield* Effect.scope;

			// Mount ink ONCE for the entire runMain lifetime. Each restart
			// cycle re-points it at the fresh engine via `tuiMount.install`;
			// the panel updates in-place across cycles instead of the
			// previous cycle's frame being committed to terminal scrollback
			// and the next cycle rendering below it (the symptom of
			// mounting per-cycle: visually-stacked panels look like
			// duplicated output, not an in-place update).
			const tuiMount = renderer === 'tui' ? yield* startTuiOnce() : undefined;

			// Tracks the cycle engine currently running so the
			// `onInterrupt` handler below can flip `buildStatus` to
			// `shutting-down` + append the user-facing teardown log line
			// when SIGINT arrives from outside the TUI (terminal Ctrl-C,
			// external kill). `runOnce` writes its engine here as soon as
			// bootstrap completes and clears it on cycle teardown.
			const currentEngineRef = yield* Ref.make<EngineHandleShape | undefined>(undefined);

			const launchLoop = Effect.gen(function* () {
				let cycle = 0;
				while (true) {
					cycle += 1;
					const again = yield* runOnce(cycle, tuiMount, currentEngineRef).pipe(
						Effect.provideService(LongLivedScope, longLived),
					);
					if (!again) return;
				}
			});

			// `Effect.onInterrupt` runs synchronously BEFORE scope teardown
			// continues — that's the only window where the per-cycle engine
			// is still alive and ink's poll loop is still ticking. We flip
			// the build-status + post the teardown log line + sleep 150ms
			// to let one ink frame render before the docker-rm finalizers
			// freeze the event loop. Plain renderer's 500ms tick may miss
			// the flash on a short shutdown — that's fine; the log line
			// itself prints either way since `appendLog` writes synchronously
			// into the engine's Ref and the plain renderer flushes its diff
			// on each tick BEFORE checking whether to exit.
			yield* launchLoop.pipe(
				Effect.onInterrupt(() =>
					Effect.gen(function* () {
						const current = yield* Ref.get(currentEngineRef);
						if (current === undefined) return;
						yield* current.setBuildStatus('shutting-down');
						yield* current.appendLog({
							ts: Date.now(),
							level: 'info',
							message: SHUTDOWN_LOG_MESSAGE,
						});
						yield* Effect.sleep('150 millis');
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
