import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem';
import { Effect, Exit } from 'effect';
import { describe, expect, it } from '@effect/vitest';

import {
	SnapshotIntegrityError,
	SnapshotLayout,
	verifyArtifactIntegrity,
	writeArtifactIntegrity,
} from '../../../src/orchestrators/snapshot/index.ts';
import { withTempRoot } from '../../helpers/with-temp-root.ts';

describe('snapshot integrity tagged errors', () => {
	it.effect('reports kind=missing when integrity.json is absent', () =>
		withTempRoot('snapshot-integrity-test', (root) =>
			Effect.gen(function* () {
				const artifactDir = join(root, 'artifact');
				mkdirSync(artifactDir, { recursive: true });
				writeFileSync(join(artifactDir, 'data.bin'), 'payload');

				const exit = yield* verifyArtifactIntegrity(artifactDir).pipe(
					Effect.exit,
					Effect.provide(NodeFileSystem.layer),
				);

				expect(Exit.isFailure(exit)).toBe(true);
				const error = Exit.findErrorOption(exit);
				expect(error._tag).toBe('Some');
				if (error._tag === 'Some') {
					expect(error.value).toBeInstanceOf(SnapshotIntegrityError);
					expect(error.value.kind).toBe('missing');
				}
			}),
		),
	);

	it.effect('reports kind=corrupt when integrity.json is unparseable JSON', () =>
		withTempRoot('snapshot-integrity-test', (root) =>
			Effect.gen(function* () {
				const artifactDir = join(root, 'artifact');
				mkdirSync(artifactDir, { recursive: true });
				writeFileSync(join(artifactDir, 'data.bin'), 'payload');
				writeFileSync(join(artifactDir, SnapshotLayout.integrityFile), '{ this is not json');

				const exit = yield* verifyArtifactIntegrity(artifactDir).pipe(
					Effect.exit,
					Effect.provide(NodeFileSystem.layer),
				);

				expect(Exit.isFailure(exit)).toBe(true);
				const error = Exit.findErrorOption(exit);
				expect(error._tag).toBe('Some');
				if (error._tag === 'Some') {
					expect(error.value).toBeInstanceOf(SnapshotIntegrityError);
					expect(error.value.kind).toBe('corrupt');
				}
			}),
		),
	);

	it.effect('reports kind=corrupt when integrity.json fails schema decode', () =>
		withTempRoot('snapshot-integrity-test', (root) =>
			Effect.gen(function* () {
				const artifactDir = join(root, 'artifact');
				mkdirSync(artifactDir, { recursive: true });
				writeFileSync(join(artifactDir, 'data.bin'), 'payload');
				writeFileSync(
					join(artifactDir, SnapshotLayout.integrityFile),
					JSON.stringify({ wrong: 'shape' }),
				);

				const exit = yield* verifyArtifactIntegrity(artifactDir).pipe(
					Effect.exit,
					Effect.provide(NodeFileSystem.layer),
				);

				expect(Exit.isFailure(exit)).toBe(true);
				const error = Exit.findErrorOption(exit);
				expect(error._tag).toBe('Some');
				if (error._tag === 'Some') {
					expect(error.value).toBeInstanceOf(SnapshotIntegrityError);
					expect(error.value.kind).toBe('corrupt');
				}
			}),
		),
	);

	it.effect('reports kind=mismatch when a file hash differs from the recorded value', () =>
		withTempRoot('snapshot-integrity-test', (root) =>
			Effect.gen(function* () {
				const artifactDir = join(root, 'artifact');
				mkdirSync(artifactDir, { recursive: true });
				writeFileSync(join(artifactDir, 'data.bin'), 'original-payload');

				yield* writeArtifactIntegrity(artifactDir).pipe(Effect.provide(NodeFileSystem.layer));

				// Tamper with the file without updating the recorded hash.
				writeFileSync(join(artifactDir, 'data.bin'), 'TAMPERED-PAYLOAD');

				const exit = yield* verifyArtifactIntegrity(artifactDir).pipe(
					Effect.exit,
					Effect.provide(NodeFileSystem.layer),
				);

				expect(Exit.isFailure(exit)).toBe(true);
				const error = Exit.findErrorOption(exit);
				expect(error._tag).toBe('Some');
				if (error._tag === 'Some') {
					expect(error.value).toBeInstanceOf(SnapshotIntegrityError);
					expect(error.value.kind).toBe('mismatch');
				}
			}),
		),
	);

	it.effect('reports kind=mismatch when the file list disagrees with integrity.json', () =>
		withTempRoot('snapshot-integrity-test', (root) =>
			Effect.gen(function* () {
				const artifactDir = join(root, 'artifact');
				mkdirSync(artifactDir, { recursive: true });
				writeFileSync(join(artifactDir, 'data.bin'), 'original-payload');

				yield* writeArtifactIntegrity(artifactDir).pipe(Effect.provide(NodeFileSystem.layer));

				// Introduce a file not recorded in integrity.json.
				writeFileSync(join(artifactDir, 'rogue.bin'), 'unexpected');

				const exit = yield* verifyArtifactIntegrity(artifactDir).pipe(
					Effect.exit,
					Effect.provide(NodeFileSystem.layer),
				);

				expect(Exit.isFailure(exit)).toBe(true);
				const error = Exit.findErrorOption(exit);
				expect(error._tag).toBe('Some');
				if (error._tag === 'Some') {
					expect(error.value).toBeInstanceOf(SnapshotIntegrityError);
					expect(error.value.kind).toBe('mismatch');
				}
			}),
		),
	);
});
