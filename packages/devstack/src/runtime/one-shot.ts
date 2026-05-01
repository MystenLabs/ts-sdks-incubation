// One-shot reconciler. Powers `devstack deploy --network <n>` today and
// will power `devstack apply` / `devstack codegen` once C2 lands. A single
// invocation of `Reconciler.cycle` against a live RPC, with no supervisor,
// no file watcher, and no parallelism beyond what the reconciler itself
// provides (Emit cascade + getStatus skip predicates).
//
// Filtering (§14 Q5; see cli/filters.ts):
//   - `deployFilter` (default): skip Service; gate Seed by network; run
//     Build/Publish/Register/Emit on every network. Mirrors the inline
//     `actionRunsOnLiveNet` predicate this module shipped pre-C1.
//   - `applyFilter`: localnet runs all kinds; live nets skip Service+Build.
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
	AccountSpec,
	ActionFilter,
	ActionStatus,
	Network,
	Plugin,
	ResolvedTarget,
} from '../core/types.js';
import { expandPluginActions } from '../plugin.js';
import { RegistryImpl } from '../registry/index.js';
import { deployFilter } from '../cli/filters.js';
import { resolveAccounts } from './accounts.js';
import { DEFAULT_STACK } from './active-stack.js';
import { hydrateRegistry } from './manifest-reader.js';
import { manifestPath, writeManifest } from './manifest-writer.js';
import { Reconciler } from './reconcile.js';

export interface OneShotOptions {
	appName: string;
	appDir: string;
	network: Network;
	rpcUrl: string;
	plugins: Plugin[];
	/** Account specs from `DevstackConfig.accounts`. Resolved against the
	 * target network so `ctx.accounts.<name>` returns a `Signer` per the
	 * spec's per-network slot (or `default`). */
	accounts?: Record<string, AccountSpec>;
	/** Stack name. Live-network deploys ignore the stack dimension —
	 * manifests are still keyed by network only. Defaults to 'main'. */
	stack?: string;
	/** Skip hydration from prior manifest. Default: false (hydrate). */
	skipHydrate?: boolean;
	/** Filter applied during plugin expansion. Default: `deployFilter`
	 * (skip Service; gate Seed by network; run everything else). Override
	 * with `applyFilter` for `devstack apply` or `emitOnlyFilter` for
	 * `devstack codegen`. */
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

export interface OneShotResult {
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
	const filter = opts.actionFilter ?? deployFilter;
	const allActions = expandPluginActions(opts.plugins);
	const filtered = allActions.filter((a) => filter(a, target));
	const scoped =
		opts.actionScope === undefined || opts.actionScope.length === 0
			? filtered
			: scopeActions(filtered, opts.actionScope);

	const accounts = resolveAccounts({
		specs: opts.accounts ?? {},
		appDir: opts.appDir,
		stack,
		network: opts.network,
		rpcUrl: opts.rpcUrl,
	});

	const registry = new RegistryImpl();
	const hydrated = opts.skipHydrate
		? false
		: hydrateRegistry({ appDir: opts.appDir, stack, network: opts.network, registry });

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

	const reconciler = new Reconciler();
	const result = await reconciler.cycle(scoped, {
		appName: opts.appName,
		appDir: opts.appDir,
		stack,
		network: opts.network,
		registry,
		accounts,
		// Filters may have stripped Service/Build actions whose dependents
		// are still in `filtered`. Drop the orphaned `needs` edges instead
		// of throwing.
		lenient: true,
	});

	const path = opts.readOnly
		? manifestPath({ appDir: opts.appDir, stack, network: opts.network })
		: writeManifest({
				appName: opts.appName,
				appDir: opts.appDir,
				stack,
				network: opts.network,
				registry,
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
			// Strip capability suffixes: `cap:before` / `cap:after`. The
			// scope walk follows direct deps; capability resolution
			// happens in topo. We intentionally drop these because we
			// can't (without a full pre-resolve) know which provider was
			// going to satisfy them — but we record the capability name
			// so the user gets a heads-up.
			if (need.endsWith(':before') || need.endsWith(':after')) {
				droppedCapabilities.add(need);
				continue;
			}
			enqueue(need);
		}
	}

	if (droppedCapabilities.size > 0) {
		// eslint-disable-next-line no-console
		console.warn(
			`devstack apply: scope walk dropped capability queries [${Array.from(droppedCapabilities).join(', ')}]. ` +
				'Their providers will not be included in this cycle. If a provider is required, ' +
				'add it explicitly to --actions.',
		);
	}

	return actions.filter((a) => keep.has(a.name));
}
