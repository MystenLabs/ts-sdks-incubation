// Manifest emitter — endpoint-keyed envelope, atomic write.
//
// Architecture § Manifest data model. The envelope is L0 (`identity`
// tuple, `manifestVersion`, `endpoints` lookup, `extras`).
//
// The emitter:
//   - Walks endpoint entries to build the flat `endpoints` lookup
//     keyed by `endpointKey`. Entries carry the declared endpoint
//     `name` for build-integration lookup.
//   - Writes atomically via tempfile + fsync + rename. The atomic-
//     write primitive lives in L0 (per architecture § Collapsed:
//     "Three tempfile+rename impls → one atomic-write primitive").
//   - Validates the envelope against `ManifestEnvelopeSchema` on read.
//   - Pins `manifestVersion` so future-proofing migrations have a
//     compatibility seam. The pinned version is `1`.
//
// Discipline: zero service names. The schema validates the envelope
// shape, not the per-plugin contents.

import { Effect } from 'effect';
import { Data } from 'effect';
import { FileSystem } from 'effect';

import type { EndpointKey, PluginKey } from '../../brand.ts';
import {
	type EndpointEntry,
	type ManifestCodegen,
	type ManifestExtras,
	type ManifestEnvelope,
	ManifestEnvelopeSchema,
} from '../../manifest.ts';
import { atomicWriteFile } from '../atomic-write.ts';
import { decodeJsonText } from '../runtime-decode.ts';

// -----------------------------------------------------------------------------
// Pinned schema version
// -----------------------------------------------------------------------------

/**
 * Schema version pinned at the envelope level. Bump only on a
 * breaking shape change to the envelope (NOT to a per-plugin service
 * slice — those carry their own version via Codegenable contribution).
 *
 * Reader policy:
 *   - Equal version: accept.
 *   - Older version: refuse (advise user to re-run `up`).
 *   - Newer version: refuse (build integration is out of date).
 */
export const CURRENT_MANIFEST_VERSION = 1 as const;

// -----------------------------------------------------------------------------
// Errors
// -----------------------------------------------------------------------------

/** One error class for every manifest IO failure. */
export class ManifestError extends Data.TaggedError('ManifestError')<{
	readonly reason:
		| 'write-failed'
		| 'read-failed'
		| 'decode-failed'
		| 'version-mismatch'
		| 'duplicate-contribution';
	readonly path: string;
	readonly detail?: string;
	readonly cause?: unknown;
}> {}

// -----------------------------------------------------------------------------
// Public writer interface
// -----------------------------------------------------------------------------

export interface WriteManifestInput {
	readonly identity: ManifestEnvelope['identity'];
	readonly endpoints?: ReadonlyArray<EndpointEntry>;
	readonly extras?: ManifestExtras;
	/** Per-stack codegen metadata (the resolved absolute `generatedDir`).
	 *  Optional + additive — omitting it produces an envelope without the
	 *  `codegen` key, identical to a pre-field manifest. */
	readonly codegen?: ManifestCodegen;
}

/**
 * Build the envelope from endpoint entries + extras. Pure; the writer
 * calls this and then atomically writes the JSON.
 *
 * Endpoint-key collisions error: every endpoint has a unique
 * `(pluginKey, dispatchId)` digest by construction; a duplicate means
 * a substrate bug.
 */
export const buildEnvelope = (
	input: WriteManifestInput,
): Effect.Effect<ManifestEnvelope, ManifestError> =>
	Effect.gen(function* () {
		const endpoints: Record<string, EndpointEntry> = {};
		const extras: Record<string, unknown> = { ...input.extras };

		const addEndpoint = (ep: EndpointEntry): Effect.Effect<void, ManifestError> =>
			Effect.gen(function* () {
				const ek = ep.endpointKey as string;
				if (ek in endpoints) {
					return yield* Effect.fail(
						new ManifestError({
							reason: 'duplicate-contribution',
							path: '(in-memory envelope)',
							detail: `endpointKey ${ek} contributed twice`,
						}),
					);
				}
				endpoints[ek] = ep;
			});

		for (const ep of input.endpoints ?? []) {
			yield* addEndpoint(ep);
		}

		return {
			identity: input.identity,
			manifestVersion: CURRENT_MANIFEST_VERSION,
			endpoints,
			extras,
			// Spread only when present so an omitted `codegen` yields the
			// exact same envelope (and serialized bytes) as a pre-field
			// manifest — additive, no churn for stacks that don't record it.
			...(input.codegen !== undefined ? { codegen: input.codegen } : {}),
		};
	});

// -----------------------------------------------------------------------------
// Atomic write — delegates to the canonical primitive.
// -----------------------------------------------------------------------------

/**
 * Serialize and write the envelope at `path` atomically. Routes
 * through the canonical `atomicWriteFile` primitive (mkdir-parent →
 * O_EXCL temp → write → fsync → rename), so the manifest writer
 * shares ONE owner of the tempfile dance with the cache.
 */
export const writeManifest = (
	envelope: ManifestEnvelope,
	path: string,
): Effect.Effect<void, ManifestError, FileSystem.FileSystem> =>
	Effect.gen(function* () {
		const json = serializeEnvelope(envelope);
		const bytes = new TextEncoder().encode(json);
		yield* atomicWriteFile(path, bytes).pipe(
			Effect.mapError(
				(cause) =>
					new ManifestError({
						reason: 'write-failed',
						path,
						detail: `atomic write failed at stage ${cause.stage}`,
						cause,
					}),
			),
		);
	});

const serializeEnvelope = (envelope: ManifestEnvelope): string =>
	// Stable key ordering, deterministic re-emit. `JSON.stringify` with
	// 2-space indent is reproducible byte-for-byte given the same
	// input object.
	JSON.stringify(envelope, null, 2);

// -----------------------------------------------------------------------------
// Read + decode
// -----------------------------------------------------------------------------

/**
 * Read and decode the manifest at `path`. Validates against
 * `ManifestEnvelopeSchema` and the pinned `CURRENT_MANIFEST_VERSION`.
 *
 * Used by:
 *   - Build integrations (Vitest, Playwright, generated app code) — consumes
 *     `envelope.endpoints` lookup.
 *
 * The reader is read-only; no mutation, no IO beyond the single read.
 */
export const readManifest = (
	path: string,
): Effect.Effect<ManifestEnvelope, ManifestError, FileSystem.FileSystem> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const text = yield* fs
			.readFileString(path)
			.pipe(Effect.mapError((cause) => new ManifestError({ reason: 'read-failed', path, cause })));
		const decoded = yield* decodeJsonText(ManifestEnvelopeSchema, text, {
			source: path,
			mkError: (issue) =>
				new ManifestError({ reason: 'decode-failed', path, cause: issue.cause ?? issue }),
		});
		if (decoded.manifestVersion !== CURRENT_MANIFEST_VERSION) {
			return yield* Effect.fail(
				new ManifestError({
					reason: 'version-mismatch',
					path,
					detail: `expected ${CURRENT_MANIFEST_VERSION}, got ${decoded.manifestVersion}`,
				}),
			);
		}
		return decoded as ManifestEnvelope;
	});

// -----------------------------------------------------------------------------
// Re-export the envelope + endpoint types so downstream substrate
// modules (codegen, build integrations) don't reach into substrate/
// directly.
// -----------------------------------------------------------------------------

export type { EndpointEntry, EndpointKey, ManifestCodegen, ManifestEnvelope, PluginKey };
export { ManifestEnvelopeSchema };
