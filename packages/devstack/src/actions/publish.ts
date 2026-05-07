// `publish()` — Move package publish action factory.
//
// Bakes in:
//  - default `run`: build the Move package in the sui container (live
//    nets fall back to the host's `sui` CLI), publish via
//    `publishMovePackage`, register the result in `registry.packages`.
//    Follow-on side-effects (token registration, shared-object seeding)
//    live in their own `seed()` actions that name the publish in their
//    `needs:` — keeps the action graph honest about ordering and lets
//    the reconciler skip them independently on warm cycles.
//
// No default `getStatus`: idempotence comes from the reconciler's
// input-hash skip predicate (`source digest` baked into `inputs`)
// combined with persisted state in the manifest. `publishMovePackage`
// also does its own (sourceDigest, chainId)-keyed cache hit check
// inside `run`, so even when the action does run, it skips the actual
// chain publish when nothing structural changed.
//
// Chain regenesis (sui-localnet image bump → fresh genesis) is handled
// at the supervisor level via the `<stackDir>/.chain-anchor` purge:
// the supervisor compares the live chainId against the anchor and, on
// mismatch, drops the registry's chain-bound state and the persisted
// reconciler state, so the next cycle re-runs every action with a
// clean slate. Per-action chain probes here would duplicate that.
//
// Plugin authors who need a custom shape (the imports plugin's
// curated-address path on live nets, seal's `prepareSource` flow) use
// `prepareSource` to swap the source-materialization step.

import { existsSync } from 'node:fs';
import { isAbsolute, resolve as resolvePath } from 'node:path';
import type { ActionRunContext, Provides, PublishAction } from '../core/types.js';
import {
	buildPriorCacheEntry,
	computeSourceDigest,
	publishMovePackage,
} from '../helpers/move-package.js';
import { openSuiRpcClient } from '../helpers/sui-client.js';
import { suiContainerName } from '../plugins/sui/index.js';

export interface PublishInputs extends Record<string, unknown> {
	path: string;
	capture?: Record<string, string>;
	publisher?: string;
	/** SHA-256 of the Move source dir at action-construction time. Folded
	 * into the action's input hash so a Move source edit busts the
	 * reconciler's skip predicate even when no other input changed.
	 * Undefined when the source dir isn't on host (`prepareSource` flow,
	 * imported packages) or when the path is relative to a yet-unknown
	 * `appDir` — those cases skip the digest and rely on whatever other
	 * input identifies source identity (image tag, git rev, etc.). */
	sourceDigest?: string;
}

interface PublishOptions {
	name: string;
	needs?: string[];
	provides?: Provides;
	/** Move package source directory, OR — when `prepareSource` is set —
	 * a stable label used for input hashing and the file watcher (e.g.
	 * a docker image tag). Absolute on-host paths used as-is; relative
	 * on-host paths resolved against `ctx.appDir` at run time. */
	path: string;
	/**
	 * Object-type filters mapped by capture key.
	 *
	 * Two filter forms (see `helpers/match-type.ts`):
	 *
	 *   `'::module::Type'`        — Suffix match. Matches any object whose
	 *                                full type ends with the filter. Use for
	 *                                non-generic types (`'::admin::AdminCap'`,
	 *                                `'::registry::Registry'`).
	 *   `'::module::Type<'`       — Generic type match. Trailing `<` opts
	 *                                into a substring match so the filter
	 *                                matches `Type<X>` for any type
	 *                                arguments (`'::coin::TreasuryCap<'`,
	 *                                `'::coin::CoinMetadata<'`).
	 *
	 * Without the trailing `<`, generic types fail to match because the
	 * suffix never aligns. Forgetting it is the single most-common
	 * silent-failure mode of `publish()`.
	 */
	capture?: Record<string, string>;
	/** Account name to sign the publish tx. Defaults to `'publisher'`. */
	publisher?: string;
	/** Registry entry name. Defaults to `opts.name` (the bare action name
	 * the plugin author wrote, before auto-prefixing). Use this when the
	 * package's logical name differs from the action's. */
	registryAs?: string;
	/** Run-time hook that materializes the package's source directory —
	 * e.g. extract sources baked into a docker image into a tmpdir. The
	 * returned `dir` is passed to `publishMovePackage`; `cleanup` (if
	 * provided) runs in a finally after publish. When set, no
	 * `registry.packages.path` is recorded (codegen silently skips
	 * pathless entries — appropriate for in-image sources). */
	prepareSource?: (
		ctx: ActionRunContext,
	) => Promise<{ dir: string; cleanup?: () => Promise<void> | void }>;
	/** Optional liveness probe. Most callers leave this undefined — the
	 * reconciler's hash-match skip is sufficient. Pass when there's an
	 * orthogonal invariant to check (e.g. a downstream object the
	 * publish created might be destroyed off-chain). */
	getStatus?: (ctx: ActionRunContext) => Promise<{ ok: boolean; detail?: string }>;
	/** Optional identity override. Default = registered `packageId`,
	 * which is what every downstream Register/Seed/Move-call reads, so
	 * a republish auto-cascades. */
	identity?: (ctx: ActionRunContext) => Promise<string | undefined>;
}

export function publish(opts: PublishOptions): PublishAction<PublishInputs> {
	const registryName = opts.registryAs ?? opts.name;
	const publisherAccount = opts.publisher ?? 'publisher';
	const inputs: PublishInputs = {
		path: opts.path,
		capture: opts.capture,
		publisher: publisherAccount,
		sourceDigest: digestAtExpansion(opts.path, opts.prepareSource !== undefined),
	};
	// Auto `provides.registry`: every Publish action re-registers its
	// package from manifest-hydrated state on the warm-skip path. The
	// reconciler's per-action registry proxy then stamps `providedBy`
	// onto it, which is what wires the package into the supervisor's
	// status row outputs (`package <name> <packageId>`). Without this,
	// a warm cycle (publish.getStatus → ok, no run) leaves the
	// hydrated entry's `providedBy` un-refreshed and the row shows no
	// outputs. Plugins can still pass their own `provides.registry`
	// for additional rehydrate work — we run the auto-hook first.
	const provides: Provides = {
		...(opts.provides?.capabilities !== undefined && {
			capabilities: opts.provides.capabilities,
		}),
		registry: async (ctx) => {
			const existing = ctx.registry.packages.find(registryName);
			if (existing !== undefined) ctx.registry.packages.register(existing);
			if (opts.provides?.registry !== undefined) {
				await opts.provides.registry(ctx);
			}
		},
	};
	return {
		name: opts.name,
		type: 'Publish',
		needs: opts.needs,
		provides,
		path: opts.path,
		runsAs: publisherAccount,
		inputs,
		getStatus: opts.getStatus,
		identity:
			opts.identity ??
			(async (ctx) => ctx.registry.packages.find(registryName)?.packageId),
		run: async (ctx) => {
			// Publish runs on every network. On localnet, the build step
			// shells `sui move build` inside the localnet container — no
			// host sui CLI required. On live nets the container isn't
			// running; the build runs against the host's sui CLI
			// (`buildEnv: 'host'`). Either way the publish tx submits
			// via SDK against `ctx.registry.services.require('sui-rpc')`'s
			// URL (live-net's `runOneShot` pre-registers the network's
			// RPC into that slot).
			let sourceDir: string;
			let cleanup: (() => Promise<void> | void) | undefined;
			let registerPath: string | undefined;
			if (opts.prepareSource !== undefined) {
				const prepared = await opts.prepareSource(ctx);
				sourceDir = prepared.dir;
				cleanup = prepared.cleanup;
				// In-image sources have no on-host path worth surfacing to
				// codegen — leave registerPath undefined so codegen skips
				// the package, matching the seal/imports-style precedent.
			} else {
				sourceDir = isAbsolute(opts.path) ? opts.path : resolvePath(ctx.appDir, opts.path);
				registerPath = sourceDir;
			}
			try {
				const isLocalnet = ctx.network === 'localnet';
				const containerName =
					ctx.network === 'localnet' ? suiContainerName(ctx.appName, ctx.stack) : undefined;
				const publisher = ctx.accounts.get(publisherAccount);
				const client = openSuiRpcClient(ctx);
				const chainId = await client.getChainIdentifier();
				const prior = buildPriorCacheEntry(ctx.registry.packages.find(registryName));
				const result = await publishMovePackage({
					containerName,
					packagePath: sourceDir,
					publisher,
					client,
					capture: opts.capture,
					chainId,
					prior,
					buildEnv: isLocalnet ? 'container' : 'host',
				});
				ctx.registry.packages.register({
					name: registryName,
					packageId: result.packageId,
					captured: result.captured,
					sourceDigest: result.sourceDigest,
					chainId,
					network: ctx.network,
					path: registerPath,
				});
			} finally {
				if (cleanup !== undefined) await cleanup();
			}
		},
	};
}

/** Compute a Move source digest if the path is absolute and exists.
 * Returns undefined for `prepareSource` flows (in-image sources) and
 * for paths the action expansion can't resolve to a real on-host dir. */
function digestAtExpansion(sourcePath: string, prepareSource: boolean): string | undefined {
	if (prepareSource) return undefined;
	if (!isAbsolute(sourcePath)) return undefined;
	if (!existsSync(sourcePath)) return undefined;
	try {
		return computeSourceDigest(sourcePath);
	} catch {
		return undefined;
	}
}
