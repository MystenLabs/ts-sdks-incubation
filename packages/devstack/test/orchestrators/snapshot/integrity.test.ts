import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem';
import { Effect, Exit } from 'effect';
import { afterEach, beforeEach, describe, expect, it } from '@effect/vitest';

import {
	SnapshotIntegrityError,
	SnapshotLayout,
	verifyArtifactIntegrity,
	writeArtifactIntegrity,
} from '../../../src/orchestrators/snapshot/index.ts';

const freshRoot = (): string => mkdtempSync(join(tmpdir(), 'snapshot-integrity-test-'));

describe('snapshot integrity tagged errors', () => {
	let root: string;

	beforeEach(() => {
		root = freshRoot();
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	it.effect('reports kind=missing when integrity.json is absent', () =>
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
	);

	it.effect('reports kind=corrupt when integrity.json is unparseable JSON', () =>
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
	);

	it.effect('reports kind=corrupt when integrity.json fails schema decode', () =>
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
	);

	it.effect('reports kind=mismatch when a file hash differs from the recorded value', () =>
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
	);

	it.effect('reports kind=mismatch when the file list disagrees with integrity.json', () =>
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
	);
});
