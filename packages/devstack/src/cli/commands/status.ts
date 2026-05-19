// `devstack status` — read-only dump of `.devstack/state.json` and
// `.devstack/manifest.json`. Does NOT build any layers / acquire any
// primitives, so it's safe to run against a stack that's already up.

import { Console, Effect, FileSystem } from 'effect';
import { Command, Flag } from 'effect/unstable/cli';
import { resolve as resolvePath } from 'node:path';
import { ManifestDiscoveryError, ManifestShapeError } from '../../engine/errors.js';
import { readForkMeta } from '../../engine/sui-fork/meta.js';
import { readStackContext, type StackContext } from '../../runtime/read-stack-context.js';
import { resolveForkMetaPath, resolveStackFromEnv, stateDir } from '../stack-resolution.js';

// Action-time env read — see manifest.ts for the rationale.
const stateFile = (): string => `${stateDir()}/stacks/${resolveStackFromEnv(undefined)}/state.json`;

interface ParsedFile {
	readonly path: string;
	readonly exists: boolean;
	readonly content?: unknown;
	readonly parseError?: string;
}

// Tolerate missing / malformed files — status is observational, it must
// not throw just because the stack hasn't been brought up yet.
const tryReadJson = (filePath: string): Effect.Effect<ParsedFile, never, FileSystem.FileSystem> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const absolute = resolvePath(process.cwd(), filePath);
		const exists = yield* fs.exists(filePath).pipe(Effect.orElseSucceed(() => false));
		if (!exists) return { path: absolute, exists: false };
		const raw = yield* fs.readFileString(filePath).pipe(
			Effect.map((txt) => ({ ok: true as const, txt })),
			Effect.catch((cause) => Effect.succeed({ ok: false as const, cause })),
		);
		if (!raw.ok) {
			return { path: absolute, exists: true, parseError: `failed to read: ${String(raw.cause)}` };
		}
		try {
			return { path: absolute, exists: true, content: JSON.parse(raw.txt) as unknown };
		} catch (cause) {
			return { path: absolute, exists: true, parseError: `failed to parse JSON: ${String(cause)}` };
		}
	});

interface ManifestSlot {
	readonly path: string;
	readonly exists: boolean;
	readonly ctx?: StackContext;
	readonly parseError?: string;
}

/** Read the manifest tolerantly via the shared reader — surfaces
 *  decode failures as `parseError` instead of propagating, so the
 *  status command still prints something useful for a stale or absent
 *  manifest. */
const tryReadManifest = (): Effect.Effect<ManifestSlot> => {
	const fallbackPath = `${stateDir()}/stacks/${resolveStackFromEnv(undefined)}/manifest.json`;
	const absoluteFallback = resolvePath(process.cwd(), fallbackPath);
	return readStackContext().pipe(
		Effect.map(
			(ctx): ManifestSlot => ({
				path: ctx.manifestPath,
				exists: true,
				ctx,
			}),
		),
		Effect.catchTag(
			'ManifestDiscoveryError',
			(_cause: ManifestDiscoveryError): Effect.Effect<ManifestSlot> =>
				Effect.succeed({ path: absoluteFallback, exists: false }),
		),
		Effect.catchTag(
			'ManifestShapeError',
			(cause: ManifestShapeError): Effect.Effect<ManifestSlot> =>
				Effect.succeed({
					path: cause.path,
					exists: true,
					parseError:
						cause.phase === 'parse'
							? `failed to parse JSON: ${String(cause.cause ?? cause.message)}`
							: cause.message,
				}),
		),
	);
};

export const statusCommand = Command.make(
	'status',
	{
		json: Flag.boolean('json'),
	},
	({ json }) =>
		Effect.gen(function* () {
			const state = yield* tryReadJson(stateFile());
			const manifest = yield* tryReadManifest();

			// Phase 4 P4.9 — surface the per-stack `sui-fork/meta.json`
			// fields under a dedicated `chain:` section so operators
			// can read the fork's upstream + checkpoint + configHash
			// without booting any layers. The block stays absent for
			// non-fork stacks (no meta.json on disk).
			const stack = resolveStackFromEnv(undefined);
			const forkMetaPath = resolveForkMetaPath({ stack });
			const forkMeta = yield* readForkMeta(forkMetaPath);

			// Build the chain block for JSON / human render. Pulls chainId
			// from manifest.services.sui (set by the supervisor at
			// acquire time) and the fork-mode static fields from
			// meta.json (upstream + forkedAtCheckpoint when the user
			// pinned it). `lastCheckpoint` / `clockMs` are dynamic
			// runtime values — sourced live via `devstack fork status`,
			// not from disk — so this section omits them.
			const manifestSui = manifest.ctx?.sui;
			const chainBlock =
				manifestSui !== undefined || forkMeta !== undefined
					? {
							...(manifestSui?.chainId !== undefined ? { chainId: manifestSui.chainId } : {}),
							...(manifestSui?.network !== undefined ? { network: manifestSui.network } : {}),
							...(forkMeta !== undefined
								? {
										upstream: forkMeta.upstream,
										...(forkMeta.checkpoint !== undefined ? { forkedAt: forkMeta.checkpoint } : {}),
										configHash: forkMeta.configHash,
										seedAddresses: forkMeta.seedAddresses,
										seedObjects: forkMeta.seedObjects,
									}
								: {}),
						}
					: undefined;

			if (json) {
				yield* Console.log(
					JSON.stringify({
						command: 'status',
						state: {
							path: state.path,
							exists: state.exists,
							...(state.content !== undefined ? { content: state.content } : {}),
							...(state.parseError !== undefined ? { error: state.parseError } : {}),
						},
						manifest: {
							path: manifest.path,
							exists: manifest.exists,
							...(manifest.ctx !== undefined ? { content: manifest.ctx.manifest } : {}),
							...(manifest.parseError !== undefined ? { error: manifest.parseError } : {}),
						},
						...(chainBlock !== undefined ? { chain: chainBlock } : {}),
					}),
				);
				return;
			}

			// Human-readable: keep it terse, ~one section per file. Endpoints
			// and packages are surfaced from the manifest because that's the
			// shape downstream consumers (vitest fixture, dapp config) read.
			yield* Console.log(`devstack status`);
			yield* Console.log(`  state:    ${state.path} ${state.exists ? '' : '(missing)'}`);
			if (state.parseError !== undefined) {
				yield* Console.log(`    ! ${state.parseError}`);
			}
			yield* Console.log(`  manifest: ${manifest.path} ${manifest.exists ? '' : '(missing)'}`);
			if (manifest.parseError !== undefined) {
				yield* Console.log(`    ! ${manifest.parseError}`);
			}

			if (chainBlock !== undefined) {
				yield* Console.log(`  chain:`);
				if (chainBlock.chainId !== undefined) {
					yield* Console.log(`    chainId:    ${chainBlock.chainId}`);
				}
				if (chainBlock.network !== undefined) {
					yield* Console.log(`    network:    ${chainBlock.network}`);
				}
				if (chainBlock.upstream !== undefined) {
					yield* Console.log(`    upstream:   ${chainBlock.upstream}`);
				}
				if (chainBlock.forkedAt !== undefined) {
					yield* Console.log(`    forkedAt:   ${chainBlock.forkedAt}`);
				}
				if (chainBlock.configHash !== undefined) {
					yield* Console.log(`    configHash: ${chainBlock.configHash}`);
				}
				if (chainBlock.seedAddresses !== undefined && chainBlock.seedAddresses.length > 0) {
					yield* Console.log(`    seedAddresses: ${chainBlock.seedAddresses.join(', ')}`);
				}
				if (chainBlock.seedObjects !== undefined && chainBlock.seedObjects.length > 0) {
					yield* Console.log(`    seedObjects:   ${chainBlock.seedObjects.join(', ')}`);
				}
				if (forkMeta !== undefined) {
					yield* Console.log(
						`    (lastCheckpoint / clockMs are runtime values — see \`devstack fork status\`)`,
					);
				}
			}

			if (manifest.ctx !== undefined) {
				// Project endpoints out of the typed v5 manifest. Mirrors the
				// flat-array shape the prior `endpoints[]` projection rendered.
				const m = manifest.ctx.manifest;
				const printedEps: Array<{ name: string; url: string }> = [];
				if (m.services.sui !== undefined) {
					printedEps.push({ name: 'sui-rpc', url: m.services.sui.rpc.url });
					if (m.services.sui.faucet !== undefined)
						printedEps.push({ name: 'sui-faucet', url: m.services.sui.faucet.url });
					if (m.services.sui.graphql !== undefined)
						printedEps.push({ name: 'sui-graphql', url: m.services.sui.graphql.url });
				}
				if (m.services.seal !== undefined)
					printedEps.push({ name: 'seal-key-server', url: m.services.seal.keyServer.url });
				if (m.services.walrus !== undefined) {
					printedEps.push({ name: 'walrus-aggregator', url: m.services.walrus.aggregator.url });
					printedEps.push({ name: 'walrus-publisher', url: m.services.walrus.publisher.url });
				}
				if (m.app.dev !== undefined)
					printedEps.push({ name: 'frontend.dev-server', url: m.app.dev.url });
				if (m.app.wallet !== undefined) printedEps.push({ name: 'wallet-app', url: m.app.wallet.url });
				if (printedEps.length > 0) {
					yield* Console.log(`  endpoints:`);
					for (const ep of printedEps) {
						yield* Console.log(`    ${ep.name}: ${ep.url}`);
					}
				}
				const pkgs = Object.entries(m.packages);
				if (pkgs.length > 0) {
					yield* Console.log(`  packages:`);
					for (const [name, pkg] of pkgs) {
						yield* Console.log(`    ${name}: ${pkg.id}`);
					}
				}
				const accts = Object.entries(m.accounts);
				if (accts.length > 0) {
					yield* Console.log(`  accounts:`);
					for (const [name, acct] of accts) {
						yield* Console.log(`    ${name}: ${acct.address}`);
					}
				}
			}
		}),
).pipe(Command.withDescription('Print the current .devstack state.json + manifest.json'));
