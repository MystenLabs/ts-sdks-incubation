// `publish()` — low-level Move package publish action factory (escape
// hatch for plugins that need full control over the run/getStatus
// bodies). For the common shape — build, publish, register, optional
// post-publish hook — prefer `definePublishAction()` below.

import { existsSync } from 'node:fs';
import { isAbsolute, resolve as resolvePath } from 'node:path';
import { SuiJsonRpcClient } from '@mysten/sui/jsonRpc';
import type { ActionRunContext, Provides, PublishAction } from '../core/types.js';
import {
	buildPriorCacheEntry,
	computeSourceDigest,
	publishMovePackage,
	type PublishMovePackageResult,
} from '../helpers/move-package.js';
import { suiContainerName } from '../plugins/sui/index.js';

export interface PublishOptions {
	name: string;
	needs?: string[];
	provides?: Provides;
	/** Move package directory (relative to app dir). */
	path: string;
	/** Object-type filters: `{ adminCap: '::admin::AdminCap' }`. */
	capture?: Record<string, string>;
	/** Account name from the `accounts` registry to sign the publish tx. Defaults to first account. */
	publisher?: string;
	/** Required so plugin code can perform the actual publish; reconciler does no default work. */
	run: (ctx: ActionRunContext) => Promise<void>;
	/** Optional richer skip check (e.g. confirm packageId still exists on chain). */
	getStatus?: (ctx: ActionRunContext) => Promise<{ ok: boolean; detail?: string }>;
}

export function publish(opts: PublishOptions): PublishAction<PublishInputs> {
	return {
		name: opts.name,
		type: 'Publish',
		needs: opts.needs,
		provides: opts.provides,
		path: opts.path,
		inputs: {
			path: opts.path,
			capture: opts.capture,
			publisher: opts.publisher,
		},
		run: opts.run,
		getStatus: opts.getStatus,
	};
}

export interface PublishInputs extends Record<string, unknown> {
	path: string;
	capture?: Record<string, string>;
	publisher?: string;
}

/**
 * Higher-level Publish factory. Bakes in:
 *  - default `getStatus`: chainId + on-chain liveness probe against the
 *    cached entry in `registry.packages`.
 *  - default `run`: build the Move package in the sui container, publish
 *    via `publishMovePackage`, register the result in `registry.packages`,
 *    invoke `onPublished(ctx, result)` on a fresh publish (skipped on
 *    cache hit).
 *
 * Replaces the hand-rolled Publish action body that the example apps and
 * the seal plugin currently duplicate. The bare-bones `publish()` factory
 * remains as the escape hatch for callers that need a custom shape (e.g.
 * the imports plugin's curated-address path on live nets).
 */
export function definePublishAction(
	opts: DefinePublishActionOptions,
): PublishAction<PublishInputs> {
	const registryName = opts.registryAs ?? opts.name;
	const publisherAccount = opts.publisher ?? 'publisher';
	const inputs: PublishInputs = {
		path: opts.sourcePath,
		capture: opts.capture,
		publisher: publisherAccount,
	};
	return {
		name: opts.name,
		type: 'Publish',
		needs: opts.needs,
		provides: opts.provides,
		path: opts.sourcePath,
		inputs,
		getStatus: async (ctx) => {
			const prior = ctx.registry.packages.find(registryName);
			if (prior === undefined) return { ok: false, detail: 'no prior publish' };
			const client = openSuiClient(ctx);
			const chainId = await client.getChainIdentifier();
			if (prior.chainId !== chainId) {
				return { ok: false, detail: 'chainId differs from prior publish' };
			}
			const live = await client.getObject({ id: prior.packageId });
			if (live.data === null || live.data === undefined) {
				return { ok: false, detail: `${prior.packageId} not on chain` };
			}
			// Compare current source digest against the cached one — if the
			// developer edited Move sources since the last publish, force a
			// republish even though the old packageId is still live on chain.
			// (`prepareSource` plugins like seal own digesting themselves.
			// The on-host source dir may not exist when running against a
			// pre-emitted manifest from another repo — skip silently.)
			if (opts.prepareSource === undefined && prior.sourceDigest !== undefined) {
				const sourceDir = isAbsolute(opts.sourcePath)
					? opts.sourcePath
					: resolvePath(ctx.appDir, opts.sourcePath);
				if (existsSync(sourceDir)) {
					const currentDigest = computeSourceDigest(sourceDir);
					if (currentDigest !== prior.sourceDigest) {
						return { ok: false, detail: 'source digest changed' };
					}
				}
			}
			return { ok: true, detail: prior.packageId };
		},
		run: async (ctx) => {
			// Publish runs on every network. On localnet, the build step shells
			// `sui move build` inside the localnet container — no host sui CLI
			// required. On live nets the container isn't running; the build
			// runs against the host's sui CLI (`buildEnv: 'host'`). Either way
			// the publish tx submits via SDK against `ctx.registry.services
			// .require('sui-rpc')`'s URL (live-net's `runOneShot` pre-registers
			// the network's RPC into that slot).
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
				sourceDir = isAbsolute(opts.sourcePath)
					? opts.sourcePath
					: resolvePath(ctx.appDir, opts.sourcePath);
				registerPath = sourceDir;
			}
			try {
				const isLocalnet = ctx.network === 'localnet';
				const containerName =
					ctx.network === 'localnet' ? suiContainerName(ctx.appName, ctx.stack) : undefined;
				const publisher = ctx.accounts.get(publisherAccount);
				const client = openSuiClient(ctx);
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
				if (!result.cacheHit && opts.onPublished !== undefined) {
					await opts.onPublished(ctx, result);
				}
			} finally {
				if (cleanup !== undefined) await cleanup();
			}
		},
	};
}

export interface DefinePublishActionOptions {
	name: string;
	needs?: string[];
	provides?: Provides;
	/** Move package source directory, OR — when `prepareSource` is set —
	 * a stable label used for input hashing and the file watcher (e.g.
	 * a docker image tag). Absolute on-host paths used as-is; relative
	 * on-host paths resolved against `ctx.appDir` at run time. */
	sourcePath: string;
	/** Object-type filters: `{ adminCap: '::admin::AdminCap' }`. */
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
	/** Side-effect hook fired after a fresh publish — token registration,
	 * shared-object seeding, etc. Skipped on cache hit (the package
	 * didn't actually republish). */
	onPublished?: (ctx: ActionRunContext, result: PublishMovePackageResult) => Promise<void> | void;
}

function openSuiClient(ctx: ActionRunContext): SuiJsonRpcClient {
	const url = ctx.registry.services.require('sui-rpc').url;
	return new SuiJsonRpcClient({ url, network: ctx.network });
}
