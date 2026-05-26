import { createHash } from 'node:crypto';

import { Effect, FileSystem, Schema, Stream } from 'effect';

import {
	IntegrityFileSchema,
	SNAPSHOT_INTEGRITY_VERSION,
	SnapshotLayout,
	isSafeSnapshotRelativePath,
	type IntegrityFile,
} from './descriptor.ts';

const SHA256_HEX = /^[a-f0-9]{64}$/;

/** Tagged failure raised by snapshot integrity helpers. `kind`
 *  discriminates the failure class so downstream phase classifiers can
 *  branch by tag, not by message substring. */
export class SnapshotIntegrityError extends Schema.TaggedErrorClass<SnapshotIntegrityError>()(
	'SnapshotIntegrityError',
	{
		/**
		 * - `'missing'` — `integrity.json` file absent.
		 * - `'corrupt'` — present but unparseable / schema-decode failure.
		 * - `'mismatch'` — present, parses, but a file's hash does not
		 *   match its recorded value (or the file list disagrees).
		 * - `'walk-failed'` — directory walk failure (filesystem error
		 *   during enumeration, hashing, or write of the integrity doc).
		 */
		kind: Schema.Literals(['missing', 'corrupt', 'mismatch', 'walk-failed']),
		detail: Schema.String,
		path: Schema.optional(Schema.String),
		cause: Schema.optional(Schema.Defect),
	},
) {}

const failWalk = (
	detail: string,
	path?: string,
	cause?: unknown,
): Effect.Effect<never, SnapshotIntegrityError> =>
	Effect.fail(new SnapshotIntegrityError({ kind: 'walk-failed', detail, path, cause }));

const failCorrupt = (
	detail: string,
	path?: string,
	cause?: unknown,
): Effect.Effect<never, SnapshotIntegrityError> =>
	Effect.fail(new SnapshotIntegrityError({ kind: 'corrupt', detail, path, cause }));

const failMismatch = (
	detail: string,
	path?: string,
): Effect.Effect<never, SnapshotIntegrityError> =>
	Effect.fail(new SnapshotIntegrityError({ kind: 'mismatch', detail, path }));

const hashFile = (
	path: string,
): Effect.Effect<string, SnapshotIntegrityError, FileSystem.FileSystem> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const hash = createHash('sha256');
		yield* Stream.runForEach(fs.stream(path), (chunk) =>
			Effect.sync(() => {
				hash.update(chunk);
			}),
		).pipe(Effect.catch((cause) => failWalk(`hash ${path} failed`, path, cause)));
		return hash.digest('hex');
	});

const collectArtifactFiles = (
	root: string,
): Effect.Effect<ReadonlyArray<string>, SnapshotIntegrityError, FileSystem.FileSystem> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const files: string[] = [];
		const walk = (dir: string, prefix: string): Effect.Effect<void, SnapshotIntegrityError> =>
			Effect.gen(function* () {
				const names = yield* fs
					.readDirectory(dir)
					.pipe(Effect.catch((cause) => failWalk(`readDirectory(${dir}) failed`, dir, cause)));
				for (const name of names) {
					const relPath = prefix === '' ? name : `${prefix}/${name}`;
					if (!isSafeSnapshotRelativePath(relPath)) {
						return yield* failWalk(`unsafe artifact relative path: ${relPath}`, relPath);
					}
					const absPath = `${dir}/${name}`;
					const stat = yield* fs
						.stat(absPath)
						.pipe(Effect.catch((cause) => failWalk(`stat(${absPath}) failed`, absPath, cause)));
					if (stat.type === 'Directory') {
						yield* walk(absPath, relPath);
					} else if (stat.type === 'File') {
						if (relPath !== SnapshotLayout.integrityFile) {
							files.push(relPath);
						}
					} else {
						return yield* failWalk(
							`snapshot artifact path is not a regular file: ${relPath}`,
							absPath,
						);
					}
				}
			});
		yield* walk(root, '');
		return files.sort((a, b) => a.localeCompare(b));
	});

export const computeArtifactIntegrity = (
	root: string,
): Effect.Effect<IntegrityFile, SnapshotIntegrityError, FileSystem.FileSystem> =>
	Effect.gen(function* () {
		const hashes: Record<string, string> = {};
		for (const relPath of yield* collectArtifactFiles(root)) {
			hashes[relPath] = yield* hashFile(`${root}/${relPath}`);
		}
		return { version: SNAPSHOT_INTEGRITY_VERSION, hashes };
	});

export const writeArtifactIntegrity = (
	root: string,
): Effect.Effect<IntegrityFile, SnapshotIntegrityError, FileSystem.FileSystem> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const integrity = yield* computeArtifactIntegrity(root);
		const path = `${root}/${SnapshotLayout.integrityFile}`;
		yield* fs
			.writeFileString(path, JSON.stringify(integrity, null, 2))
			.pipe(
				Effect.catch((cause) =>
					failWalk(`write ${SnapshotLayout.integrityFile} failed`, path, cause),
				),
			);
		return integrity;
	});

const readIntegrity = (
	root: string,
): Effect.Effect<IntegrityFile, SnapshotIntegrityError, FileSystem.FileSystem> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const path = `${root}/${SnapshotLayout.integrityFile}`;
		const exists = yield* fs.exists(path).pipe(Effect.catch(() => Effect.succeed(false)));
		if (!exists) {
			return yield* Effect.fail(
				new SnapshotIntegrityError({
					kind: 'missing',
					detail: `snapshot integrity file absent at ${path}`,
					path,
				}),
			);
		}
		const text = yield* fs
			.readFileString(path)
			.pipe(Effect.catch((cause) => failWalk(`read ${path} failed`, path, cause)));
		const raw = yield* Effect.try({
			try: () => JSON.parse(text) as unknown,
			catch: (cause) =>
				new SnapshotIntegrityError({
					kind: 'corrupt',
					detail: `${path} is not valid JSON`,
					path,
					cause,
				}),
		});
		const decoded = yield* Schema.decodeUnknownEffect(IntegrityFileSchema)(raw).pipe(
			Effect.catch((cause) => failCorrupt(`${path} failed schema decode`, path, cause)),
		);
		for (const [relPath, digest] of Object.entries(decoded.hashes)) {
			if (!isSafeSnapshotRelativePath(relPath) || relPath === SnapshotLayout.integrityFile) {
				return yield* failCorrupt(`unsafe integrity path: ${relPath}`, path);
			}
			if (!SHA256_HEX.test(digest)) {
				return yield* failCorrupt(`invalid sha256 digest for ${relPath}`, path);
			}
		}
		return decoded;
	});

export const verifyArtifactIntegrity = (
	root: string,
): Effect.Effect<void, SnapshotIntegrityError, FileSystem.FileSystem> =>
	Effect.gen(function* () {
		const expected = yield* readIntegrity(root);
		const actual = yield* computeArtifactIntegrity(root);
		const expectedPaths = Object.keys(expected.hashes).sort((a, b) => a.localeCompare(b));
		const actualPaths = Object.keys(actual.hashes).sort((a, b) => a.localeCompare(b));
		if (expectedPaths.join('\n') !== actualPaths.join('\n')) {
			return yield* failMismatch('snapshot integrity file list does not match artifact contents');
		}
		for (const relPath of expectedPaths) {
			if (expected.hashes[relPath] !== actual.hashes[relPath]) {
				return yield* failMismatch(`snapshot integrity mismatch for ${relPath}`, relPath);
			}
		}
	});
