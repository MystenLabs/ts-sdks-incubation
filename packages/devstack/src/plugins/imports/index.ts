// Imports plugin. Materializes Build + Publish actions for upstream Move
// packages declared at config-load time. Mirrors the wallet example's
// hand-rolled DeepBook block — generalized so any Sui app can pull in
// curated packages by `(repo, rev, subdir)` without per-app boilerplate.
//
// Per declared package, the plugin emits two actions:
//
//   imports.<name>-source — Build. Ensures the content-addressed
//                           `dev-examples/upstream-source:<repo>-<rev>`
//                           image exists. No-op on live nets that have a
//                           curated `addresses[network]` set.
//   imports.<name>        — Publish. On localnet, runs `importMovePackage`
//                           (docker-cp the source into the sui container,
//                           publish via `sui client test-publish`). On live
//                           nets with `addresses[network]` set, registers
//                           the curated address and skips on-chain work.
//                           On live nets without a curated address, falls
//                           through to the same import flow as localnet.
//                           Provides capability `imports.<name>` so
//                           downstream actions can soft-depend via
//                           `needs: ['imports.<name>:before']`.
//
// Recursion (Move.toml dep walking) is workstream D2 — D1 ships the
// single-package case that mirrors today's hand-rolled blocks.

import { buildImage } from '../../actions/build.js';
import {
	type Action,
	type ActionRunContext,
	type Network,
	type PublishAction,
	requireLocalnetCtx,
} from '../../core/types.js';
import {
	type ImportedPackageCacheEntry,
	importMovePackage,
} from '../../helpers/imported-package.js';
import { createLocalSuiClient } from '../../helpers/sui-client.js';
import {
	ensureUpstreamSourceImage,
	upstreamSourceImageTag,
} from '../../helpers/upstream-source.js';
import { definePlugin } from '../../plugin.js';
import { imageExists } from '../sui/docker.js';
import { suiContainerName } from '../sui/index.js';
import { type ResolveSeed, resolveImports } from './resolve.js';

const IMPORT_NAME_RE = /^[a-z][a-z0-9_-]*$/;

export interface ImportSpec {
	/** Logical name. Becomes the `registry.packages` key, the per-package
	 * action suffix (`imports.<name>`, `imports.<name>-source`), and the
	 * capability identifier (`imports.<name>`). Lowercase letters, digits,
	 * `_` and `-` only. No dots. */
	name: string;
	/** GitHub `<owner>/<repo>`. */
	repo: string;
	/** Git rev (tag, branch, or commit). Bumping busts the source-image
	 * cache and forces a re-import on the next cycle. */
	rev: string;
	/** Subdir within the repo where the package's `Move.toml` lives. */
	subdir: string;
	/** Object-type filters: `{ adminCap: '::admin::AdminCap' }`. Captured
	 * object ids land on the `registry.packages` entry's `captured` map. */
	capture?: Record<string, string>;
	/** Account name (from `config.accounts`) to sign the publish tx.
	 * Defaults to `'publisher'`. The account's resolved factory must
	 * produce a `Keypair`-shaped Signer — the import flow exports the
	 * bech32 secret into the in-container CLI keystore. */
	publisher?: string;
	/** Sui environment name passed to `--build-env`. Default `'localnet'`.
	 * The import helper auto-injects the env stub when the package's
	 * `Move.toml` lacks an `[environments]` block. */
	env?: string;
	/** Curated live-network addresses. When set for the resolved network,
	 * the Publish action skips local work and registers the curated
	 * `packageId` directly. Useful for known-deployed packages (DeepBook
	 * v3, Pyth, etc.). Unset for a network → forces a real publish on
	 * that network (e.g. publishing a fresh copy on testnet). */
	addresses?: Partial<Record<Network, string>>;
	/** Names of other ImportSpecs this one depends on (matched by `name`).
	 * Populated by `withRecursiveDeps` when the recursive walker resolves
	 * Move.toml git deps; users can also set it manually for hand-curated
	 * dep chains. The Publish action gains a `needs` edge for each entry
	 * so dep packages publish before their dependents. */
	dependsOn?: string[];
}

export interface ImportsPluginOptions {
	packages: ImportSpec[];
}

export const imports = (opts: ImportsPluginOptions) => {
	const seen = new Set<string>();
	for (const spec of opts.packages) {
		validateImportName(spec.name);
		if (seen.has(spec.name)) {
			throw new Error(`imports: duplicate package name '${spec.name}'`);
		}
		seen.add(spec.name);
	}
	const specs = opts.packages.map(applyDepLinks);
	return definePlugin({
		name: 'imports',
		actions: () => specs.flatMap(buildActionsForSpec),
	});
};

/**
 * Async helper for recursive Move.toml dep walking. Given a list of
 * top-level seed specs, returns an expanded `ImportSpec[]` containing
 * every transitively-required git package (deduped by `(repo, rev,
 * subdir)`, framework deps to `MystenLabs/sui` skipped). Each resolved
 * spec carries a `dependsOn` list so the imports plugin's per-package
 * Publish actions chain in topo order.
 *
 * Use at config-load time:
 *
 *   const packages = await withRecursiveDeps([{ name: 'deepbook', ... }]);
 *   export default defineDevstackConfig({
 *     plugins: [sui(), imports({ packages }), ...],
 *   });
 *
 * The first call clones source images for every transitively-required
 * package — slow on cold cache, fast on warm (image cache by `(repo,
 * rev)`). Local (`{ local = "..." }`) deps stay inside their parent's
 * source tree and publish via `--with-unpublished-dependencies`; they
 * are NOT enqueued as separate ImportSpecs.
 */
export async function withRecursiveDeps(seeds: ImportSpec[]): Promise<ImportSpec[]> {
	const seedShape: ResolveSeed[] = seeds.map((s) => ({
		name: s.name,
		repo: s.repo,
		rev: s.rev,
		subdir: s.subdir,
	}));
	const { resolved } = await resolveImports(seedShape);
	const seedByName = new Map(seeds.map((s) => [s.name, s]));
	return resolved.map((entry) => {
		const seedSpec = seedByName.get(entry.name);
		const base: ImportSpec = seedSpec ?? {
			name: entry.name,
			repo: entry.repo,
			rev: entry.rev,
			subdir: entry.subdir,
		};
		const depNames = entry.depKeys
			.map((depKey) => {
				const depEntry = resolved.find((r) => r.key === depKey);
				return depEntry?.name;
			})
			.filter((n): n is string => n !== undefined);
		return { ...base, dependsOn: depNames };
	});
}

function applyDepLinks(spec: ImportSpec): InternalImportSpec {
	return { ...spec, dependsOn: spec.dependsOn ?? [] };
}

interface InternalImportSpec extends ImportSpec {
	dependsOn: string[];
}

function buildActionsForSpec(spec: InternalImportSpec): Action[] {
	const imageTag = upstreamSourceImageTag(spec.repo, spec.rev);
	const publisherAccount = spec.publisher ?? 'publisher';
	const env = spec.env ?? 'localnet';
	const sourceActionName = `${spec.name}-source`;
	const depPublishNeeds = spec.dependsOn.map((d) => d);

	return [
		buildImage({
			name: sourceActionName,
			inputs: { image: imageTag, repo: spec.repo, rev: spec.rev, subdir: spec.subdir },
			getStatus: async (ctx) => {
				if (curatedAddressFor(spec, ctx.network) !== undefined) {
					return { ok: true, detail: 'curated address; no source image needed' };
				}
				return (await imageExists(imageTag))
					? { ok: true, detail: imageTag }
					: { ok: false, detail: `image ${imageTag} missing` };
			},
			run: async (ctx) => {
				if (curatedAddressFor(spec, ctx.network) !== undefined) return;
				await ensureUpstreamSourceImage({ repo: spec.repo, rev: spec.rev });
			},
		}),

		{
			name: spec.name,
			type: 'Publish',
			needs: [sourceActionName, 'sui.accounts', ...depPublishNeeds],
			provides: [`imports.${spec.name}`],
			path: '<imported>',
			inputs: {
				repo: spec.repo,
				rev: spec.rev,
				subdir: spec.subdir,
				env,
				publisher: publisherAccount,
				addresses: spec.addresses,
			},
			getStatus: async (ctx) => {
				const curated = curatedAddressFor(spec, ctx.network);
				if (curated !== undefined) {
					const prior = ctx.registry.packages.find(spec.name);
					if (prior?.packageId !== curated) {
						ctx.registry.packages.register({
							name: spec.name,
							packageId: curated,
							captured: {},
							network: ctx.network,
						});
					}
					return { ok: true, detail: `curated ${curated}` };
				}
				const prior = ctx.registry.packages.find(spec.name);
				if (prior === undefined) return { ok: false, detail: 'no prior import' };
				const client = openSuiClient(ctx);
				const chainId = await client.getChainIdentifier();
				if (prior.chainId !== chainId) {
					return { ok: false, detail: 'chainId differs from prior import' };
				}
				const live = await client.getObject({ id: prior.packageId });
				if (live.data === null || live.data === undefined) {
					return { ok: false, detail: `${prior.packageId} not on chain` };
				}
				for (const [depName, depId] of Object.entries(prior.deps ?? {})) {
					const depLive = await client.getObject({ id: depId });
					if (depLive.data === null || depLive.data === undefined) {
						return { ok: false, detail: `dep ${depName} (${depId}) not on chain` };
					}
				}
				return { ok: true, detail: prior.packageId };
			},
			run: async (ctx) => {
				const curated = curatedAddressFor(spec, ctx.network);
				if (curated !== undefined) {
					ctx.registry.packages.register({
						name: spec.name,
						packageId: curated,
						captured: {},
						network: ctx.network,
					});
					return;
				}
				// Falling through to importMovePackage — needs the in-container
				// sui CLI, so the curated path above is the only live-net option.
				requireLocalnetCtx(ctx);
				const containerName = suiContainerName(ctx.appName, ctx.stack);
				const client = openSuiClient(ctx);
				const chainId = await client.getChainIdentifier();
				const publisher = ctx.accounts.get(publisherAccount);
				const prior = buildImportedPriorEntry(ctx.registry.packages.find(spec.name));
				const result = await importMovePackage({
					containerName,
					repo: spec.repo,
					rev: spec.rev,
					subdir: spec.subdir,
					alias: spec.name,
					chainId,
					prior,
					publisher,
					capture: spec.capture,
					env,
				});
				ctx.registry.packages.register({
					name: spec.name,
					packageId: result.packageId,
					captured: result.captured,
					deps: result.deps,
					sourceDigest: result.sourceDigest,
					chainId,
					network: ctx.network,
				});
			},
		} satisfies PublishAction,
	];
}

function validateImportName(name: string): void {
	if (!IMPORT_NAME_RE.test(name)) {
		throw new Error(
			`imports: invalid package name '${name}'. Must start with a lowercase ` +
				"letter and contain only lowercase letters, digits, '_' or '-'.",
		);
	}
}

function curatedAddressFor(spec: ImportSpec, network: Network): string | undefined {
	if (network === 'localnet') return undefined;
	return spec.addresses?.[network];
}

function buildImportedPriorEntry(
	entry: ReturnType<ActionRunContext['registry']['packages']['find']>,
): ImportedPackageCacheEntry | undefined {
	if (entry === undefined) return undefined;
	if (entry.sourceDigest === undefined || entry.chainId === undefined) return undefined;
	return {
		packageId: entry.packageId,
		captured: entry.captured,
		deps: entry.deps ?? {},
		sourceDigest: entry.sourceDigest,
		chainId: entry.chainId,
	};
}

function openSuiClient(ctx: ActionRunContext) {
	return createLocalSuiClient(ctx.registry.services.require('sui-rpc').url, ctx.network);
}
