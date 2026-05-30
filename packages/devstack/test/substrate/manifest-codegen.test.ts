// Manifest `codegen` field — round-trip + back-compat regression.
//
// The supervisor records the resolved absolute codegen output dir at
// `manifest.codegen.generatedDir` so the read-side Vite plugin aliases
// `@generated` at the EXACT dir codegen emitted into for this stack.
// The field is OPTIONAL + ADDITIVE (src/substrate/manifest.ts):
//   - `buildEnvelope` spreads `codegen` ONLY when supplied, so an
//     omitted `codegen` yields byte-identical serialized JSON to a
//     pre-field manifest (no churn for stacks that don't record it).
//   - `ManifestEnvelopeSchema` declares `codegen` as `Schema.optional`,
//     so a manifest written before the field existed still decodes.
//
// We drive the real serialize → schema-decode path through
// `writeManifest` + `readManifest` (both go through
// `ManifestEnvelopeSchema`), so a schema regression that dropped or
// mis-typed the optional field would fail here.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from '@effect/vitest';
import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem';
import { Effect } from 'effect';

import {
	buildEnvelope,
	readManifest,
	writeManifest,
	CURRENT_MANIFEST_VERSION,
} from '../../src/substrate/runtime/manifest/index.ts';
import { withTempRoot } from '../helpers/with-temp-root.ts';

const IDENTITY = { app: 'demo', stack: 'main', chain: 'sui:local' } as const;
const GENERATED_DIR = '/abs/x';

describe('manifest codegen field', () => {
	it.effect('round-trips codegen.generatedDir through write → read (decode/re-encode preserves it)', () =>
		withTempRoot('devstack-manifest-codegen', (tmp) =>
			Effect.gen(function* () {
				const manifestPath = join(tmp, '.devstack', 'stacks', 'main', 'manifest.json');
				const envelope = yield* buildEnvelope({
					identity: IDENTITY,
					contributions: [],
					codegen: { generatedDir: GENERATED_DIR },
				});
				// buildEnvelope carries the field into the in-memory envelope.
				expect(envelope.codegen).toEqual({ generatedDir: GENERATED_DIR });

				yield* writeManifest(envelope, manifestPath);
				// readManifest decodes through ManifestEnvelopeSchema — the
				// optional `codegen` struct survives the decode round-trip.
				const decoded = yield* readManifest(manifestPath);
				expect(decoded.codegen).toEqual({ generatedDir: GENERATED_DIR });
				expect(decoded.manifestVersion).toBe(CURRENT_MANIFEST_VERSION);
			}).pipe(Effect.provide(NodeFileSystem.layer)),
		),
	);

	it.effect('a manifest WITHOUT codegen still decodes (back-compat) and omits the key', () =>
		withTempRoot('devstack-manifest-codegen', (tmp) =>
			Effect.gen(function* () {
				const manifestPath = join(tmp, '.devstack', 'stacks', 'main', 'manifest.json');
				const envelope = yield* buildEnvelope({
					identity: IDENTITY,
					contributions: [],
					// No `codegen` — the additive field must be absent.
				});
				// Omitting `codegen` leaves the key off the envelope entirely
				// (not present-as-undefined): `'codegen' in envelope` is false.
				expect('codegen' in envelope).toBe(false);

				yield* writeManifest(envelope, manifestPath);
				// The on-disk JSON has no `codegen` key — proving the spread
				// guard omits it rather than emitting `"codegen": null`.
				const onDisk: unknown = JSON.parse(readFileSync(manifestPath, 'utf8'));
				expect(Object.prototype.hasOwnProperty.call(onDisk, 'codegen')).toBe(false);

				// And the codegen-less manifest still decodes (the schema's
				// optional field tolerates the absence — back-compat).
				const decoded = yield* readManifest(manifestPath);
				expect(decoded.codegen).toBeUndefined();
			}).pipe(Effect.provide(NodeFileSystem.layer)),
		),
	);

	it.effect('omitting codegen serializes byte-identical to a hand-built pre-feature envelope', () =>
		withTempRoot('devstack-manifest-codegen', (tmp) =>
			Effect.gen(function* () {
				const manifestPath = join(tmp, '.devstack', 'stacks', 'main', 'manifest.json');
				const envelope = yield* buildEnvelope({
					identity: IDENTITY,
					contributions: [],
				});
				yield* writeManifest(envelope, manifestPath);
				const bytes = readFileSync(manifestPath, 'utf8');

				// What a pre-`codegen`-feature writer produced for the same
				// inputs: the exact envelope object minus any codegen key,
				// serialized with the same 2-space indent the emitter uses.
				const preFeature = {
					identity: IDENTITY,
					manifestVersion: CURRENT_MANIFEST_VERSION,
					services: {},
					endpoints: {},
					extras: {},
				};
				expect(bytes).toBe(JSON.stringify(preFeature, null, 2));
			}).pipe(Effect.provide(NodeFileSystem.layer)),
		),
	);
});
