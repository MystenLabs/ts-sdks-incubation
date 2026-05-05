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

import { existsSync } from 'node:fs';
import { isAbsolute } from 'node:path';

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
import { computeSourceDigest } from '../../helpers/move-package.js';
import { openSuiRpcClient } from '../../helpers/sui-client.js';
import {
	ensureUpstreamSourceImage,
	upstreamSourceImageTag,
} from '../../helpers/upstream-source.js';
import { definePlugin } from '../../plugin.js';
import { imageExists } from '../sui/docker.js';
import { suiContainerName } from '../sui/index.js';

const IMPORT_NAME_RE = /^[a-z][a-z0-9_-]*$/;

interface ImportSpecCommon {
	/** Logical name. Becomes the `registry.packages` key, the per-package
	 * action suffix (`imports.<name>`, `imports.<name>-source`), and the
	 * capability identifier (`imports.<name>`). Lowercase letters, digits,
	 * `_` and `-` only. No dots. */
	name: string;
	/** Subdir within the source tree where the package's `Move.toml` lives. */
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
	 * Set this manually for hand-curated dep chains. The Publish action
	 * gains a `needs` edge for each entry so dep packages publish before
	 * their dependents. */
	dependsOn?: string[];
}

/** Git-source variant: clone `repo@rev`, build a content-addressed
 * source image, publish out of it. */
interface GitImportSpec extends ImportSpecCommon {
	/** Source repo `<owner>/<repo>`. With `gitUrl` unset, becomes
	 * `https://github.com/<owner>/<repo>.git`; pass `gitUrl` to override. */
	repo: string;
	/** Git rev (tag, branch, or commit). Bumping busts the source-image
	 * cache and forces a re-import on the next cycle. */
	rev: string;
	/** Override the git clone URL. Default builds
	 * `https://github.com/<repo>.git`. Pass an explicit URL with a
	 * `<repo>` token, or a `(repo, rev) => url` factory. Useful for
	 * non-GitHub hosts (private GitLab, Bitbucket, …). */
	gitUrl?: string | ((repo: string, rev: string) => string);
}

/** Local-source variant: skip the git clone + image build and use an
 * on-host working tree directly. Critical for upstream contributors
 * iterating on a Move package without pushing/cloning. */
interface LocalImportSpec extends ImportSpecCommon {
	/** On-host path to the source tree's root (the dir containing the
	 * package subdirs). Resolved against `appDir` if relative. */
	local: { path: string };
}

type ImportSpec = GitImportSpec | LocalImportSpec;

function isLocalImport(spec: ImportSpec): spec is LocalImportSpec {
	return 'local' in spec;
}

interface ImportsPluginOptions {
	packages: ImportSpec[];
}

export const imports = (opts: ImportsPluginOptions) => {
	const seen = new Set<string>();
	// Track revs per repo so we can warn when a single git repo is pinned
	// to multiple revs across specs. Two specs from the same repo at
	// different revs publish from different built-source images, almost
	// always a config mistake (subdir packages from `MystenLabs/deepbookv3`
	// at v6.0.0 vs. v7.0.0, e.g.) — silently produces two on-chain copies
	// of the same Move package and the second one wins on subsequent reads
	// of `@reg/<name>` references. Localnet-only failure mode; surface it.
	const revsByRepo = new Map<string, Map<string, string[]>>();
	for (const spec of opts.packages) {
		validateImportName(spec.name);
		if (seen.has(spec.name)) {
			throw new Error(`imports: duplicate package name '${spec.name}'`);
		}
		seen.add(spec.name);
		if (!isLocalImport(spec)) {
			let revMap = revsByRepo.get(spec.repo);
			if (revMap === undefined) {
				revMap = new Map();
				revsByRepo.set(spec.repo, revMap);
			}
			let names = revMap.get(spec.rev);
			if (names === undefined) {
				names = [];
				revMap.set(spec.rev, names);
			}
			names.push(spec.name);
		}
	}
	for (const [repo, revs] of revsByRepo) {
		if (revs.size <= 1) continue;
		const detail = Array.from(revs.entries())
			.map(([rev, names]) => `${rev} → [${names.join(', ')}]`)
			.join('; ');
		process.stderr.write(
			`imports: warning — ${repo} pinned to ${revs.size} different revs: ${detail}. ` +
				`Two specs from the same repo at different revs build separate source ` +
				`images and produce different package IDs; align the \`rev:\` fields ` +
				`unless you genuinely need both versions side-by-side.\n`,
		);
	}
	const specs = opts.packages.map(applyDepLinks);
	return definePlugin({
		name: 'imports',
		// Folded into the snapshot id. Bumping any spec's `(repo, rev,
		// subdir)` re-fetches + re-publishes the package, producing
		// different on-chain object IDs — so the cached snapshot's
		// captures wouldn't match. Curated `addresses[network]` are also
		// part of the hash since they pin the live-net result.
		inputs: specs.map((s) =>
			isLocalImport(s)
				? {
						kind: 'local',
						name: s.name,
						path: s.local.path,
						publisher: s.publisher,
						env: s.env,
						addresses: s.addresses ?? null,
					}
				: {
						kind: 'git',
						name: s.name,
						repo: s.repo,
						rev: s.rev,
						subdir: s.subdir,
						publisher: s.publisher,
						env: s.env,
						addresses: s.addresses ?? null,
					},
		),
		actions: () => specs.flatMap(buildActionsForSpec),
	});
};

function applyDepLinks(spec: ImportSpec): InternalImportSpec {
	if (isLocalImport(spec)) {
		return { ...spec, dependsOn: spec.dependsOn ?? [] };
	}
	return { ...spec, dependsOn: spec.dependsOn ?? [] };
}

type InternalImportSpec =
	| (GitImportSpec & { dependsOn: string[] })
	| (LocalImportSpec & { dependsOn: string[] });

function buildActionsForSpec(spec: InternalImportSpec): Action[] {
	const publisherAccount = spec.publisher ?? 'publisher';
	const env = spec.env ?? 'localnet';
	const sourceActionName = `${spec.name}-source`;
	const depPublishNeeds = spec.dependsOn.map((d) => d);

	// Local imports include a content digest so editing Move sources
	// busts the reconciler's hash-match skip. Git imports key on (repo,
	// rev) — same rev → same content by construction. The digest is
	// computed at action-construction time; falls back to undefined when
	// the path can't be resolved (relative path, unknown appDir).
	const localSourceDigest = isLocalImport(spec)
		? safeDigest(`${spec.local.path}/${spec.subdir}`)
		: undefined;

	const sourceInputs = isLocalImport(spec)
		? { local: spec.local.path, subdir: spec.subdir, digest: localSourceDigest }
		: {
				image: upstreamSourceImageTag(spec.repo, spec.rev),
				repo: spec.repo,
				rev: spec.rev,
				subdir: spec.subdir,
			};

	const publishInputs = isLocalImport(spec)
		? {
				local: spec.local.path,
				subdir: spec.subdir,
				env,
				publisher: publisherAccount,
				addresses: spec.addresses,
				digest: localSourceDigest,
			}
		: {
				repo: spec.repo,
				rev: spec.rev,
				subdir: spec.subdir,
				env,
				publisher: publisherAccount,
				addresses: spec.addresses,
			};

	return [
		buildImage({
			name: sourceActionName,
			inputs: sourceInputs,
			watches: isLocalImport(spec)
				? [
						`${spec.local.path}/${spec.subdir}/Move.toml`,
						`${spec.local.path}/${spec.subdir}/sources/**`,
					]
				: undefined,
			getStatus: async (ctx) => {
				if (curatedAddressFor(spec, ctx.network) !== undefined) {
					return { ok: true, detail: 'curated address; no source image needed' };
				}
				if (isLocalImport(spec)) {
					const { existsSync } = await import('node:fs');
					const { isAbsolute, resolve: resolvePath } = await import('node:path');
					const path = isAbsolute(spec.local.path)
						? spec.local.path
						: resolvePath(ctx.appDir, spec.local.path);
					return existsSync(path)
						? { ok: true, detail: `local: ${path}` }
						: { ok: false, detail: `local path missing: ${path}` };
				}
				const imageTag = upstreamSourceImageTag(spec.repo, spec.rev);
				return (await imageExists(imageTag))
					? { ok: true, detail: imageTag }
					: { ok: false, detail: `image ${imageTag} missing` };
			},
			run: async (ctx) => {
				if (curatedAddressFor(spec, ctx.network) !== undefined) return;
				if (isLocalImport(spec)) return;
				await ensureUpstreamSourceImage({
					repo: spec.repo,
					rev: spec.rev,
					gitUrl: spec.gitUrl,
					appendLog: ctx.appendLog,
				});
			},
		}),

		{
			name: spec.name,
			type: 'Publish',
			needs: [sourceActionName, 'accounts.fund', ...depPublishNeeds],
			provides: {
				capabilities: [`imports.${spec.name}`],
				// Re-register on warm-path skip so downstream consumers
				// (codegen, deepbook pools) see the package without
				// rerunning `run`. The curated-address case relies on
				// this to land in the registry on cycles where the
				// reconciler's hash-match skip fires.
				registry: (ctx) => {
					const prior = ctx.registry.packages.find(spec.name);
					if (prior !== undefined) return;
					const curated = curatedAddressFor(spec, ctx.network);
					if (curated !== undefined) {
						ctx.registry.packages.register({
							name: spec.name,
							packageId: curated,
							captured: {},
							network: ctx.network,
						});
					}
				},
			},
			path: '<imported>',
			runsAs: publisherAccount,
			inputs: publishInputs,
			// No default getStatus. Hash-match + persisted state covers
			// the warm path; chainId-regenesis is detected via
			// `Package.chainId` recorded post-publish (when a user runs
			// `devstack reset --yes`, the manifest is wiped, state is
			// empty, action runs fresh). On manual external regenesis,
			// run `devstack reset` to clear stale state.
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
				const client = openSuiRpcClient(ctx);
				const chainId = await client.getChainIdentifier();
				const publisher = ctx.accounts.get(publisherAccount);
				const prior = buildImportedPriorEntry(ctx.registry.packages.find(spec.name));
				let localPath: string | undefined;
				let repo: string;
				let rev: string;
				let gitUrl: GitImportSpec['gitUrl'];
				if (isLocalImport(spec)) {
					const { isAbsolute, resolve: resolvePath } = await import('node:path');
					localPath = isAbsolute(spec.local.path)
						? spec.local.path
						: resolvePath(ctx.appDir, spec.local.path);
					// importMovePackage requires repo/rev for cache keying even
					// for local sources; supply stable synthetic values.
					repo = `local:${spec.name}`;
					rev = 'local';
					gitUrl = undefined;
				} else {
					repo = spec.repo;
					rev = spec.rev;
					gitUrl = spec.gitUrl;
				}
				const result = await importMovePackage({
					containerName,
					repo,
					rev,
					subdir: spec.subdir,
					alias: spec.name,
					chainId,
					prior,
					publisher,
					capture: spec.capture,
					env,
					gitUrl,
					localPath,
					appendLog: ctx.appendLog,
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

/** Compute a Move source digest if the path is absolute and on disk.
 * Local imports use this so a Move source edit busts the reconciler's
 * input-hash skip predicate. Returns undefined for relative paths
 * (action expansion can't resolve them without `appDir`). */
function safeDigest(path: string): string | undefined {
	if (!isAbsolute(path)) return undefined;
	if (!existsSync(path)) return undefined;
	try {
		return computeSourceDigest(path);
	} catch {
		return undefined;
	}
}
