// Read the substrate's manifest envelope and project per-plugin
// sections into typed shapes for the orchestrator.
//
// Architecture §6 + manifest.ts §"Discipline: zero service names" —
// the envelope's `services` slot is opaque (`Schema.Unknown`); each
// plugin's `Codegenable` contribution is the schema that decodes its
// own slice. The orchestrator does NOT decode by string literal; it
// walks the `Codegenable` decls and asks each emitter to read the
// substrate's resolved state.
//
// This module is the SEAM: in the current architecture, plugins
// pass their resolved blobs directly to `makeCodegenable(...)` at
// factory-build time (see `plugins/sui/codegen.ts`, etc.). The
// orchestrator does NOT re-read the manifest envelope to construct
// those blobs — that's the plugin's job.
//
// What this module provides is the READ-SIDE bridge: build
// integrations (Vitest, Playwright, generated app code) call `readEnvelope()` to
// pull the on-disk envelope for endpoint lookups. Same path the
// codegen orchestrator can call AFTER the manifest writer fires —
// for any future emitter that wants the on-disk endpoint table.

import { Effect, FileSystem } from 'effect';

import { readManifest, type ManifestEnvelope } from '../../substrate/runtime/manifest/index.ts';

import { CodegenManifestDrift } from './errors.ts';

/**
 * Read the on-disk manifest envelope from `path`. Wraps
 * `readManifest` (substrate L0) with a codegen-tagged error so
 * orchestrator callers can `catchTags({ CodegenManifestDrift, ... })`
 * uniformly.
 *
 * Returns `null` when the manifest does not exist yet — i.e. this
 * cycle is the first emit and the manifest writer has not fired.
 * Emitters that don't NEED the envelope (most don't — they take the
 * resolved blob via the closure) ignore the null; emitters that DO
 * need it (endpoint-list emitters) skip-emit and log.
 */
export const readEnvelope = (
	path: string,
): Effect.Effect<ManifestEnvelope | null, CodegenManifestDrift, FileSystem.FileSystem> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const exists = yield* fs.exists(path).pipe(Effect.orElseSucceed(() => false));
		if (!exists) return null;
		return yield* readManifest(path).pipe(
			Effect.mapError(
				(cause) =>
					new CodegenManifestDrift({
						detail: `failed to read manifest at ${path}: ${cause._tag} (${cause.reason})`,
					}),
			),
		);
	}).pipe(
		Effect.withSpan('codegen.readEnvelope', {
			attributes: { 'codegen.manifestPath': path },
		}),
	);

/**
 * Project a single plugin's services slice. The orchestrator does
 * not decode by name — this helper exists for downstream consumers
 * (build integrations) that need to look up a specific plugin's
 * blob. The plugin key is BRANDed at the substrate layer.
 */
export const projectPluginSlice = (envelope: ManifestEnvelope, pluginKey: string): unknown =>
	envelope.services[pluginKey];

/**
 * Project the flat endpoint lookup. Build integrations consume this
 * for URL → endpoint mapping; the codegen orchestrator may consume
 * it for a future endpoints.ts emitter.
 */
export const projectEndpoints = (envelope: ManifestEnvelope): ManifestEnvelope['endpoints'] =>
	envelope.endpoints;
