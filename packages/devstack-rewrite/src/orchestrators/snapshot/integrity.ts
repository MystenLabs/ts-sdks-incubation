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

const fail = (detail: string): Effect.Effect<never, Error> => Effect.fail(new Error(detail));

const hashFile = (path: string): Effect.Effect<string, Error, FileSystem.FileSystem> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const hash = createHash('sha256');
		yield* Stream.runForEach(fs.stream(path), (chunk) =>
			Effect.sync(() => {
				hash.update(chunk);
			}),
		).pipe(Effect.catch((cause) => fail(`hash ${path} failed: ${String(cause)}`)));
		return hash.digest('hex');
	});

const collectArtifactFiles = (
	root: string,
): Effect.Effect<ReadonlyArray<string>, Error, FileSystem.FileSystem> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const files: string[] = [];
		const walk = (dir: string, prefix: string): Effect.Effect<void, Error> =>
			Effect.gen(function* () {
				const names = yield* fs
					.readDirectory(dir)
					.pipe(Effect.catch((cause) => fail(`readDirectory(${dir}) failed: ${String(cause)}`)));
				for (const name of names) {
					const relPath = prefix === '' ? name : `${prefix}/${name}`;
					if (!isSafeSnapshotRelativePath(relPath)) {
						return yield* fail(`unsafe artifact relative path: ${relPath}`);
					}
					const absPath = `${dir}/${name}`;
					const stat = yield* fs
						.stat(absPath)
						.pipe(Effect.catch((cause) => fail(`stat(${absPath}) failed: ${String(cause)}`)));
					if (stat.type === 'Directory') {
						yield* walk(absPath, relPath);
					} else if (stat.type === 'File') {
						if (relPath !== SnapshotLayout.integrityFile) {
							files.push(relPath);
						}
					} else {
						return yield* fail(`snapshot artifact path is not a regular file: ${relPath}`);
					}
				}
			});
		yield* walk(root, '');
		return files.sort((a, b) => a.localeCompare(b));
	});

export const computeArtifactIntegrity = (
	root: string,
): Effect.Effect<IntegrityFile, Error, FileSystem.FileSystem> =>
	Effect.gen(function* () {
		const hashes: Record<string, string> = {};
		for (const relPath of yield* collectArtifactFiles(root)) {
			hashes[relPath] = yield* hashFile(`${root}/${relPath}`);
		}
		return { version: SNAPSHOT_INTEGRITY_VERSION, hashes };
	});

export const writeArtifactIntegrity = (
	root: string,
): Effect.Effect<IntegrityFile, Error, FileSystem.FileSystem> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const integrity = yield* computeArtifactIntegrity(root);
		yield* fs
			.writeFileString(
				`${root}/${SnapshotLayout.integrityFile}`,
				JSON.stringify(integrity, null, 2),
			)
			.pipe(
				Effect.catch((cause) =>
					fail(`write ${SnapshotLayout.integrityFile} failed: ${String(cause)}`),
				),
			);
		return integrity;
	});

const readIntegrity = (root: string): Effect.Effect<IntegrityFile, Error, FileSystem.FileSystem> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const path = `${root}/${SnapshotLayout.integrityFile}`;
		const text = yield* fs
			.readFileString(path)
			.pipe(Effect.catch((cause) => fail(`read ${path} failed: ${String(cause)}`)));
		const raw = yield* Effect.try({
			try: () => JSON.parse(text) as unknown,
			catch: (cause) => new Error(`${path} is not valid JSON: ${String(cause)}`),
		});
		const decoded = yield* Schema.decodeUnknownEffect(IntegrityFileSchema)(raw).pipe(
			Effect.catch((cause) => fail(`${path} failed schema decode: ${String(cause)}`)),
		);
		for (const [relPath, digest] of Object.entries(decoded.hashes)) {
			if (!isSafeSnapshotRelativePath(relPath) || relPath === SnapshotLayout.integrityFile) {
				return yield* fail(`unsafe integrity path: ${relPath}`);
			}
			if (!SHA256_HEX.test(digest)) {
				return yield* fail(`invalid sha256 digest for ${relPath}`);
			}
		}
		return decoded;
	});

export const verifyArtifactIntegrity = (
	root: string,
): Effect.Effect<void, Error, FileSystem.FileSystem> =>
	Effect.gen(function* () {
		const expected = yield* readIntegrity(root);
		const actual = yield* computeArtifactIntegrity(root);
		const expectedPaths = Object.keys(expected.hashes).sort((a, b) => a.localeCompare(b));
		const actualPaths = Object.keys(actual.hashes).sort((a, b) => a.localeCompare(b));
		if (expectedPaths.join('\n') !== actualPaths.join('\n')) {
			return yield* fail('snapshot integrity file list does not match artifact contents');
		}
		for (const relPath of expectedPaths) {
			if (expected.hashes[relPath] !== actual.hashes[relPath]) {
				return yield* fail(`snapshot integrity mismatch for ${relPath}`);
			}
		}
	});
