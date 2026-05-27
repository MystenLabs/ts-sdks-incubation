// Manifest emitter — endpoint-keyed envelope, atomic write.
//
// Architecture § Manifest data model. The envelope is L0 (`identity`
// tuple, `manifestVersion`, `services` slot, `endpoints` lookup,
// `extras`). The per-service projection lives in each plugin's
// Codegenable contribution and is consumed by codegen output, not by
// the manifest envelope itself.
//
// The emitter:
//   - Accepts per-plugin contributions through a `contribute` Effect.
//   - Walks endpoint contributions to build the flat `endpoints`
//     lookup keyed by `endpointKey`. Entries still carry the declared
//     endpoint `name` for build-integration lookup.
//   - Writes atomically via tempfile + fsync + rename. The atomic-
//     write primitive lives in L0 (per architecture § Collapsed:
//     "Three tempfile+rename impls → one atomic-write primitive").
//   - Validates the envelope against `ManifestEnvelopeSchema` on read.
//   - Pins `manifestVersion` so future-proofing migrations have a
//     compatibility seam. The pinned version is `1` for the post-
//     rewrite envelope. (The old devstack used unversioned manifests
//     plus a hash field; the rewrite's clean break is `version 1`.)
//
// Discipline: zero service names. The writer iterates `pluginKey`-
// indexed contributions and copies the bytes through. The schema
// validates the envelope shape, not the per-plugin contents (which
// are `Schema.Unknown`).

import { Effect } from 'effect';
import { Data } from 'effect';
import { FileSystem } from 'effect';

import type { EndpointKey, PluginKey } from '../../brand.ts';
import {
	type EndpointEntry,
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
// Contribution shape
// -----------------------------------------------------------------------------

/**
 * One plugin's contribution to the manifest. Keyed by `pluginKey`
 * (branded), opaque `services` blob, plus a flat list of endpoint
 * entries the plugin owns.
 *
 * The writer copies `services` through to
 * `envelope.services[pluginKey]`. The renderer of the typed shape
 * lives in the plugin's Codegenable contribution — the manifest
 * doesn't decode it.
 */
export interface PluginManifestContribution {
	readonly pluginKey: PluginKey;
	/** Plugin's structured slice — opaque to the writer. */
	readonly services: unknown;
	/** Endpoints owned by this plugin. The writer indexes these by
	 *  `endpointKey` into the flat top-level lookup. */
	readonly endpoints: ReadonlyArray<EndpointEntry>;
	/** Optional app-facing extras merged into the top-level extras slot. */
	readonly extras?: ManifestExtras;
}

// -----------------------------------------------------------------------------
// Public writer interface
// -----------------------------------------------------------------------------

export interface WriteManifestInput {
	readonly identity: ManifestEnvelope['identity'];
	readonly contributions: ReadonlyArray<PluginManifestContribution>;
	readonly endpoints?: ReadonlyArray<EndpointEntry>;
	readonly extras?: ManifestExtras;
}

/**
 * Build the envelope from per-plugin contributions. Pure; the writer
 * calls this and then atomically writes the JSON.
 *
 * `pluginKey` collisions are an error — two contributions for the
 * same plugin would silently overwrite. Endpoint-key collisions also
 * error: every endpoint has a unique `(pluginKey, dispatchId)` digest
 * by construction; a duplicate means a substrate bug.
 */
export const buildEnvelope = (
	input: WriteManifestInput,
): Effect.Effect<ManifestEnvelope, ManifestError> =>
	Effect.gen(function* () {
		const services: Record<string, unknown> = {};
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

		for (const contribution of input.contributions) {
			const key = contribution.pluginKey as string;
			if (key in services) {
				return yield* Effect.fail(
					new ManifestError({
						reason: 'duplicate-contribution',
						path: '(in-memory envelope)',
						detail: `pluginKey ${key} contributed twice`,
					}),
				);
			}
			services[key] = contribution.services;
			if (contribution.extras !== undefined) {
				for (const [extraKey, extraValue] of Object.entries(contribution.extras)) {
					if (extraKey in extras) {
						return yield* Effect.fail(
							new ManifestError({
								reason: 'duplicate-contribution',
								path: '(in-memory envelope)',
								detail: `extras key ${extraKey} contributed twice`,
							}),
						);
					}
					extras[extraKey] = extraValue;
				}
			}
			for (const ep of contribution.endpoints) {
				yield* addEndpoint(ep);
			}
		}
		for (const ep of input.endpoints ?? []) {
			yield* addEndpoint(ep);
		}

		return {
			identity: input.identity,
			manifestVersion: CURRENT_MANIFEST_VERSION,
			services,
			endpoints,
			extras,
		};
	});

// -----------------------------------------------------------------------------
// Atomic write — delegates to the canonical primitive.
// -----------------------------------------------------------------------------

/**
 * Serialize and write the envelope at `path` atomically. Routes
 * through the canonical `atomicWriteFile` primitive (mkdir-parent →
 * O_EXCL temp → write → fsync → rename), so the manifest writer
 * shares ONE owner of the tempfile dance with the state-store and
 * cache.
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
	}).pipe(
		Effect.withSpan('Manifest.writeManifest', { attributes: { 'devstack.manifest.path': path } }),
	);

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
 *   - Codegen (architecture §6) — consumes plugin slices off
 *     `envelope.services[pluginKey]`.
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
	}).pipe(
		Effect.withSpan('Manifest.readManifest', { attributes: { 'devstack.manifest.path': path } }),
	);

// -----------------------------------------------------------------------------
// Re-export the envelope + endpoint types so downstream substrate
// modules (codegen, build integrations) don't reach into substrate/
// directly.
// -----------------------------------------------------------------------------

export type { EndpointEntry, EndpointKey, ManifestEnvelope, PluginKey };
export { ManifestEnvelopeSchema };
