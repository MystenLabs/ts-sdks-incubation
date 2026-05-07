// One-shot reconciler. Powers `devstack apply` and `devstack codegen`. A
// single invocation of `Reconciler.cycle` against a live RPC, with no
// supervisor, no file watcher, and no parallelism beyond what the
// reconciler itself provides (Emit cascade + getStatus skip predicates).
//
// Filtering (see cli/filters.ts):
//   - `applyFilter` (default): localnet runs every action type; live nets
//     skip Service + HostProcess (no docker assumed) but keep Build /
//     Publish / Register / Seed (network-gated) / Emit / Verify.
//   - `emitOnlyFilter`: codegen-style read-only re-emit.
//
// Why `Reconciler.cycle` instead of a bespoke parallel-level walk: the
// pre-C1 walk skipped the Emit dirty-kind cascade, so a Publish that
// re-published a package on testnet wouldn't trigger codegen even though
// codegen depends on `packages` being dirty. The reconciler runs the
// cascade at the end of every cycle. We trade per-level parallelism for
// cascade correctness — example apps publish 1–3 packages per deploy, so
// the wall-clock impact is small.
//
// Hydration: prior manifest at examples/<n>/.devstack/manifests/<network>.json
// is loaded into the registry so `getStatus()` skip predicates see prior
// on-chain state. The hydrate step does not dirty kinds; only actions
// that re-register during the cycle trigger Emit re-runs.

import type {
	AccountsConfig,
	ActionFilter,
	ActionStatus,
	Network,
	Plugin,
	ResolvedTarget,
} from '../core/types.js';
import { expandPluginActions } from '../plugin.js';
import { RegistryImpl } from '../registry/index.js';
import { applyFilter } from '../cli/filters.js';
import { resolveAccounts } from './accounts.js';
import { DEFAULT_STACK } from './active-stack.js';
import { hydrateRegistry, readReconcilerState } from './manifest-reader.js';
import { manifestPath, writeManifest } from './manifest-writer.js';
import { createPortAllocator } from './port-allocator.js';
import { Reconciler } from './reconcile.js';

interface OneShotOptions {
	appName: string;
	appDir: string;
	network: Network;
	rpcUrl: string;
	plugins: Plugin[];
	/** Account specs from `DevstackConfig.accounts`. Resolved against the
	 * target network so `ctx.accounts.<name>` returns a `Signer` per the
	 * spec's per-network slot (or `default`). */
	accounts?: AccountsConfig;
	/** Stack name. Live-network deploys ignore the stack dimension —
	 * manifests are still keyed by network only. Defaults to 'main'. */
	stack?: string;
	/** Skip hydration from prior manifest. Default: false (hydrate). */
	skipHydrate?: boolean;
	/** Filter applied during plugin expansion. Default: `applyFilter`
	 * (localnet runs every action type; live nets skip Service +
	 * HostProcess). Override with `emitOnlyFilter` for codegen-only
	 * re-emit, or with a custom predicate for ad-hoc selections. */
	actionFilter?: ActionFilter;
	/** When true, skip the post-cycle manifest write — useful for codegen,
	 * which regenerates bindings without disturbing the on-disk manifest.
	 * The returned `manifestPath` still points at the expected location. */
	readOnly?: boolean;
	/**
	 * Restrict the action graph to a subset of action names + their
	 * transitive dependencies + downstream Emit cascades. Used by
	 * `devstack apply --actions <name>...` and the REPL `.deploy <pkg>`
	 * shortcut. Each name must match an action's full name (e.g.
	 * `wallet.usdc`, `imports.deepbook`); names that don't match anything
	 * after `actionFilter` is applied are silently dropped (no-op).
	 * Empty / undefined = no scope filter; the full filtered graph runs.
	 */
	actionScope?: string[];
}

interface OneShotResult {
	statuses: Map<string, ActionStatus>;
	failures: Map<string, Error>;
	manifestPath: string;
	hydrated: boolean;
}

export async function runOneShot(opts: OneShotOptions): Promise<OneShotResult> {
	const stack = opts.stack ?? DEFAULT_STACK;
	const target: ResolvedTarget = {
		network: opts.network,
		stack,
		rpcUrl: opts.rpcUrl,
	};
	const filter = opts.actionFilter ?? applyFilter;
	const allActions = expandPluginActions(opts.plugins);
	const filtered = allActions.filter((a) => filter(a, target));
	const scoped =
		opts.actionScope === undefined || opts.actionScope.length === 0
			? filtered
			: scopeActions(filtered, opts.actionScope);

	const accounts = resolveAccounts({
		specs: opts.accounts ?? [],
		appDir: opts.appDir,
		stack,
		network: opts.network,
		rpcUrl: opts.rpcUrl,
	});

	const registry = new RegistryImpl();
	const hydrated = opts.skipHydrate
		? false
		: hydrateRegistry({ appDir: opts.appDir, stack, network: opts.network, registry });
	const priorState = opts.skipHydrate
		? {}
		: readReconcilerState({ appDir: opts.appDir, stack, network: opts.network });

	// Live-net: pre-register the network's RPC endpoint so consumers
	// (codegen Emit, REPL bindings) can `services.find('sui-rpc')` even
	// though no Service action runs. Localnet: the sui plugin registers
	// these itself in its Service `run` / `getStatus` paths.
	if (opts.network !== 'localnet') {
		registry.services.register({
			name: 'sui-rpc',
			kind: 'sui-rpc',
			url: opts.rpcUrl,
			port: 0,
			endpointLabel: `${opts.network} RPC`,
		});
		registry.flushDirty();
	}

	const reconciler = new Reconciler({ priorState });
	const ports =
		opts.network === 'localnet' ? createPortAllocator({ appDir: opts.appDir, stack }) : undefined;
	// Stream status transitions to stderr so CI consumers see which
	// actions ran without parsing the final summary. Tracked here (not
	// in the reconciler) because the supervisor uses its own progress
	// pump for the TTY renderer; piping to stderr is a one-shot concern.
	const lastStatus = new Map<string, string>();
	const result = await reconciler.cycle(scoped, {
		appName: opts.appName,
		appDir: opts.appDir,
		stack,
		network: opts.network,
		registry,
		accounts,
		ports,
		// Filters may have stripped Service/Build actions whose dependents
		// are still in `filtered`. Drop the orphaned `needs` edges instead
		// of throwing.
		lenient: true,
		// Per-action diagnostic stream → stderr. Plugins emit free-form
		// log lines via `ctx.appendLog`; the reconciler's progress
		// callback below emits one-line status transitions so stderr
		// shows progress even when no plugin writes a log.
		appendLog: (actionName, line) => {
			process.stderr.write(`[${actionName}] ${line}\n`);
		},
		progress: (snapshot) => {
			for (const [name, status] of snapshot.statuses) {
				const prev = lastStatus.get(name);
				if (prev === status) continue;
				lastStatus.set(name, status);
				// Skip the initial 'queued' burst: the renderer initializes
				// every action to queued before the topo walk starts. Stderr
				// would be noisy with N copies of "queued". Real transitions
				// (queued → running → healthy/failed/skipped) are what users
				// care about.
				if (status === 'queued' && prev === undefined) continue;
				const detail = snapshot.failures.get(name)?.message;
				const suffix = detail !== undefined ? ` — ${detail}` : '';
				process.stderr.write(`[${name}] ${status}${suffix}\n`);
			}
		},
	});

	const path = opts.readOnly
		? manifestPath({ appDir: opts.appDir, stack, network: opts.network })
		: writeManifest({
				appName: opts.appName,
				appDir: opts.appDir,
				stack,
				network: opts.network,
				registry,
				actionStates: reconciler.serializeState(),
			});

	return {
		statuses: result.statuses,
		failures: result.failures,
		manifestPath: path,
		hydrated,
	};
}

/**
 * Restrict `actions` to the named subset plus their transitive `needs`
 * deps and any downstream Emit actions whose `dependsOnKind` could be
 * dirtied by something in the subset (currently approximated as: any
 * Emit action stays in the graph if any kind it depends on could be
 * touched by a Publish/Register/Seed in the subset). Order is preserved.
 */
function scopeActions(
	actions: import('../core/types.js').Action[],
	scope: string[],
): import('../core/types.js').Action[] {
	const byName = new Map(actions.map((a) => [a.name, a]));
	const keep = new Set<string>();
	const stack: string[] = [];
	const droppedCapabilities = new Set<string>();

	const enqueue = (name: string) => {
		if (byName.has(name) && !keep.has(name)) {
			keep.add(name);
			stack.push(name);
		}
	};

	const unmatched = scope.filter((n) => !byName.has(n));
	if (unmatched.length > 0) {
		process.stderr.write(
			`devstack: scopeActions has no match for [${unmatched.join(', ')}] (after the action filter). ` +
				`Available action names: ${[...byName.keys()].join(', ')}. The cycle will run with whatever ` +
				`scope entries DID match, plus their deps.\n`,
		);
	}

	for (const name of scope) enqueue(name);

	// Always include every Emit FIRST (so the dirty-kind cascade can fire),
	// then walk transitively from both the user-named scope AND every Emit
	// to keep their direct deps. Walking Emits' needs prevents the case
	// where `apply --actions wallet.usdc` keeps `codegen.generate` but
	// drops a Publish that codegen needs — leaving codegen with an
	// orphaned edge that lenient-topo silently strips, then running
	// against possibly-stale state.
	for (const action of actions) {
		if (action.type === 'Emit') enqueue(action.name);
	}

	while (stack.length > 0) {
		const name = stack.pop();
		if (name === undefined) break;
		const action = byName.get(name);
		if (action === undefined) continue;
		for (const need of action.needs ?? []) {
			// Strip capability suffixes: `cap:before`. The scope walk
			// follows direct deps; capability resolution happens in
			// topo. We intentionally drop these because we can't
			// (without a full pre-resolve) know which provider was going
			// to satisfy them — but we record the capability name so the
			// user gets a heads-up.
			if (need.endsWith(':before')) {
				droppedCapabilities.add(need);
				continue;
			}
			enqueue(need);
		}
	}

	if (droppedCapabilities.size > 0) {
		process.stderr.write(
			`devstack apply: scope walk dropped capability queries [${Array.from(droppedCapabilities).join(', ')}]. ` +
				'Their providers will not be included in this cycle. If a provider is required, ' +
				'add it explicitly to --actions.\n',
		);
	}

	return actions.filter((a) => keep.has(a.name));
}
