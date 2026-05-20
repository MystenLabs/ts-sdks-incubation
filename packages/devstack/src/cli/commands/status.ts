// `devstack status` — read-only dump of `.devstack/state.json` and
// `.devstack/manifest.json`. Does NOT build any layers / acquire any
// primitives, so it's safe to run against a stack that's already up.

import { Console, Effect, FileSystem } from 'effect';
import { Command, Flag } from 'effect/unstable/cli';
import { resolve as resolvePath } from 'node:path';
import { ManifestDiscoveryError, ManifestShapeError } from '../../engine/errors.js';
import { readForkMeta } from '../../engine/sui-fork/meta.js';
import { readStackContext, type StackContext } from '../../runtime/read-stack-context.js';
import { emitEnvelope, jsonModeEnabled, successEnvelope } from '../envelope.js';
import { resolveForkMetaPath, resolveStackFromEnv, stateDir } from '../stack-resolution.js';
import { renderManifestBody } from './_manifest-render.js';

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
			const startedAt = Date.now();
			const useJson = jsonModeEnabled(json);
			const state = yield* tryReadJson(stateFile());
			const manifest = yield* tryReadManifest();

			// Surface the per-stack `sui-fork/meta.json`
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

			if (useJson) {
				yield* emitEnvelope(
					successEnvelope({
						command: 'status',
						data: {
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
						},
						elapsedMs: Date.now() - startedAt,
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
				// Defer to the shared renderer so endpoints / packages /
				// accounts stay bit-for-bit aligned with `devstack manifest`.
				// `status` historically omits the coins + extras blocks
				// the `manifest` command prints.
				const bodyLines = renderManifestBody(manifest.ctx.manifest);
				for (const line of bodyLines) {
					yield* Console.log(line);
				}
			}
		}),
).pipe(Command.withDescription('Print the current .devstack state.json + manifest.json'));
