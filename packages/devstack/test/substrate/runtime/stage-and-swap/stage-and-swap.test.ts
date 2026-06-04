// stage-and-swap — substrate-level atomic publish primitive.
//
// These tests exercise the lifted primitive in the new substrate
// location. The orchestrator-side forwarder (`orchestrators/snapshot/
// stage-and-swap.ts`) re-exports from substrate; deletion in PR3.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { Effect, Exit, FileSystem, PlatformError } from 'effect';
import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem';
import { describe, expect, it } from '@effect/vitest';

import {
	COMMAND_CHANNEL_COMMANDS_FILE_NAME,
	commandChannelPaths,
	makeCommandChannelPublisher,
	runtimeControlLockPathForStackRoot,
	type PublishedCommand,
} from '../../../../src/substrate/runtime/cross-process/command-channel/index.ts';
import {
	stageAndSwap,
	StageAndSwapError,
} from '../../../../src/substrate/runtime/stage-and-swap/index.ts';
import { withTempRoot } from '../../../helpers/with-temp-root.ts';

const buildSucceeds = (stagingPath: string, content: string) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		yield* fs.writeFileString(join(stagingPath, 'payload'), content);
	});

describe('stageAndSwap', () => {
	it.effect('successful build promotes staging → target atomically', () =>
		withTempRoot('stage-and-swap-test', (root) =>
			Effect.gen(function* () {
				const target = join(root, 'target');
				const staging = join(root, 'target.staging');
				const backup = join(root, 'target.bak');
				yield* stageAndSwap({
					targetPath: target,
					stagingPath: staging,
					backupPath: backup,
					build: buildSucceeds(staging, 'hello'),
				});
				expect(existsSync(target)).toBe(true);
				expect(readFileSync(join(target, 'payload'), 'utf8')).toBe('hello');
				expect(existsSync(staging)).toBe(false);
				expect(existsSync(backup)).toBe(false);
			}).pipe(Effect.provide(NodeFileSystem.layer)),
		),
	);

	it.effect('build failure leaves target untouched and removes staging', () =>
		withTempRoot('stage-and-swap-test', (root) =>
			Effect.gen(function* () {
				const target = join(root, 'target');
				writeFileSync(target + '.placeholder', 'before');
				const staging = join(root, 'target.staging');
				const backup = join(root, 'target.bak');
				const exit = yield* Effect.exit(
					stageAndSwap({
						targetPath: target,
						stagingPath: staging,
						backupPath: backup,
						build: Effect.fail({ _tag: 'UserError' as const, message: 'no' }),
					}),
				);
				expect(Exit.isFailure(exit)).toBe(true);
				expect(existsSync(staging)).toBe(false);
				expect(existsSync(target)).toBe(false);
			}).pipe(Effect.provide(NodeFileSystem.layer)),
		),
	);

	it.effect('existing target is restored from backup on rename failure', () =>
		withTempRoot('stage-and-swap-test', (root) =>
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const target = join(root, 'target');
				yield* fs.makeDirectory(target, { recursive: true });
				yield* fs.writeFileString(join(target, 'old'), 'old-content');
				const staging = join(root, 'target.staging');
				const backup = join(root, 'target.bak');
				// Successful swap path — verifies happy-path roll over an
				// existing target.
				yield* stageAndSwap({
					targetPath: target,
					stagingPath: staging,
					backupPath: backup,
					build: buildSucceeds(staging, 'new-content'),
				});
				expect(readFileSync(join(target, 'payload'), 'utf8')).toBe('new-content');
				expect(existsSync(join(target, 'old'))).toBe(false);
				expect(existsSync(backup)).toBe(false);
			}).pipe(Effect.provide(NodeFileSystem.layer)),
		),
	);

	it.effect('restores backup when the cross-filesystem fallback copy fails', () =>
		withTempRoot('stage-and-swap-test', (root) =>
			Effect.gen(function* () {
				const baseFs = yield* FileSystem.FileSystem;
				const target = join(root, 'target');
				yield* baseFs.makeDirectory(target, { recursive: true });
				yield* baseFs.writeFileString(join(target, 'old'), 'old-content');
				const staging = join(root, 'target.staging');
				const backup = join(root, 'target.bak');

				// Force the promote rename onto the EXDEV fallback, then make
				// the fallback copy fail — the previous target must be
				// restored verbatim, not orphaned at the backup path.
				//
				// A real `@effect/platform-node` rename failure is a
				// PlatformError whose `reason` is a SystemError; the raw Node
				// errno is preserved as `reason.cause` (see `handleErrnoException`
				// in platform-node-shared). The errno `code` therefore lives at
				// `reason.cause.code` (and the constructor hoists it to the
				// wrapper's `cause.code`) — NOT at the top level. Inject the errno
				// at that genuine nesting so the test exercises the real detection.
				const exdevError = PlatformError.systemError({
					_tag: 'Unknown',
					module: 'FileSystem',
					method: 'rename',
					syscall: 'rename',
					cause: Object.assign(new Error('cross-device link not permitted'), {
						code: 'EXDEV',
						syscall: 'rename',
						errno: -18,
					}),
				});
				const wrappedFs: FileSystem.FileSystem = {
					...baseFs,
					rename: (oldPath, newPath) => {
						if (oldPath === staging && newPath === target) {
							return Effect.fail(exdevError);
						}
						return baseFs.rename(oldPath, newPath);
					},
					copy: (from, to, options) => {
						if (from === staging && to === target) {
							return Effect.fail(
								PlatformError.systemError({
									_tag: 'Unknown',
									module: 'FileSystem',
									method: 'copy',
									syscall: 'copy',
								}),
							);
						}
						return baseFs.copy(from, to, options);
					},
				};

				const exit = yield* Effect.exit(
					stageAndSwap({
						targetPath: target,
						stagingPath: staging,
						backupPath: backup,
						build: buildSucceeds(staging, 'new-content'),
					}).pipe(Effect.provideService(FileSystem.FileSystem, wrappedFs)),
				);

				expect(Exit.isFailure(exit)).toBe(true);
				// Previous target restored verbatim at its original path…
				expect(existsSync(target)).toBe(true);
				expect(readFileSync(join(target, 'old'), 'utf8')).toBe('old-content');
				// …and NOT left orphaned at the backup path.
				expect(existsSync(backup)).toBe(false);
			}).pipe(Effect.provide(NodeFileSystem.layer)),
		),
	);

	it.effect('preserves selected target paths after build and before publish', () =>
		withTempRoot('stage-and-swap-test', (root) =>
			Effect.gen(function* () {
				const target = join(root, 'target');
				mkdirSync(target, { recursive: true });
				writeFileSync(join(target, 'commands.ndjson'), 'before\n');
				const staging = join(root, 'target.staging');
				const backup = join(root, 'target.bak');

				yield* stageAndSwap({
					targetPath: target,
					stagingPath: staging,
					backupPath: backup,
					preserveFromTarget: [{ relativePath: 'commands.ndjson' }],
					build: Effect.gen(function* () {
						const fs = yield* FileSystem.FileSystem;
						yield* fs.writeFileString(join(staging, 'payload'), 'new-content');
						yield* fs.writeFileString(join(target, 'commands.ndjson'), 'before\nduring-build\n');
					}),
				});

				expect(readFileSync(join(target, 'payload'), 'utf8')).toBe('new-content');
				expect(readFileSync(join(target, 'commands.ndjson'), 'utf8')).toBe(
					'before\nduring-build\n',
				);
				expect(existsSync(backup)).toBe(false);
			}).pipe(Effect.provide(NodeFileSystem.layer)),
		),
	);

	it.effect('overwrite:false keeps the staging copy and only falls back to the live copy', () =>
		withTempRoot('stage-and-swap-test', (root) =>
			Effect.gen(function* () {
				const target = join(root, 'target');
				mkdirSync(join(target, 'captured'), { recursive: true });
				mkdirSync(join(target, 'fallback'), { recursive: true });
				// Live copies present in the target (→ backed up at swap time).
				writeFileSync(join(target, 'captured', 'id'), 'live-id');
				writeFileSync(join(target, 'fallback', 'id'), 'live-fallback');
				const staging = join(root, 'target.staging');
				const backup = join(root, 'target.bak');

				yield* stageAndSwap({
					targetPath: target,
					stagingPath: staging,
					backupPath: backup,
					preserveFromTarget: [
						{ relativePath: 'captured/id', overwrite: false },
						{ relativePath: 'fallback/id', overwrite: false },
					],
					build: Effect.gen(function* () {
						const fs = yield* FileSystem.FileSystem;
						yield* fs.writeFileString(join(staging, 'payload'), 'x');
						// `captured/id` already in staging (e.g. untarred from a
						// snapshot's host-tree) — the live copy must NOT clobber it.
						// `fallback/id` is absent from staging — the live copy fills in.
						yield* fs.makeDirectory(join(staging, 'captured'), { recursive: true });
						yield* fs.writeFileString(join(staging, 'captured', 'id'), 'captured-id');
					}),
				});

				// Conflict → the staging (captured) copy wins.
				expect(readFileSync(join(target, 'captured', 'id'), 'utf8')).toBe('captured-id');
				// No conflict → the live copy is preserved as a fallback.
				expect(readFileSync(join(target, 'fallback', 'id'), 'utf8')).toBe('live-fallback');
			}).pipe(Effect.provide(NodeFileSystem.layer)),
		),
	);

	it.effect('serializes command appends started after backup and before promote', () =>
		withTempRoot('stage-and-swap-test', (root) =>
			Effect.gen(function* () {
				const target = join(root, 'target');
				mkdirSync(target, { recursive: true });
				const paths = commandChannelPaths(target);
				const publisher = yield* makeCommandChannelPublisher(paths);
				yield* publisher.publish({ tag: 'stack.start' });

				const staging = join(root, 'target.staging');
				const backup = join(root, 'target.bak');
				const baseFs = yield* FileSystem.FileSystem;
				let writerPromise: Promise<PublishedCommand> | null = null;
				let writerStarted = false;
				let writerResolved = false;
				let promoteSawWriterPending = false;

				const wrappedFs: FileSystem.FileSystem = {
					...baseFs,
					rename: (oldPath, newPath) =>
						baseFs.rename(oldPath, newPath).pipe(
							Effect.tap(() =>
								Effect.sync(() => {
									if (oldPath === target && newPath === backup) {
										writerStarted = true;
										writerPromise = Effect.runPromise(
											publisher.publish({ tag: 'shutdown.requested' }),
										);
										writerPromise.then(
											() => {
												writerResolved = true;
											},
											() => {
												writerResolved = true;
											},
										);
									}
									if (oldPath === staging && newPath === target) {
										promoteSawWriterPending = writerStarted && !writerResolved;
									}
								}),
							),
						),
				};

				yield* stageAndSwap({
					targetPath: target,
					stagingPath: staging,
					backupPath: backup,
					preserveFromTarget: [{ relativePath: COMMAND_CHANNEL_COMMANDS_FILE_NAME }],
					publishLockPath: runtimeControlLockPathForStackRoot(target),
					build: buildSucceeds(staging, 'new-content'),
				}).pipe(Effect.provideService(FileSystem.FileSystem, wrappedFs));

				expect(writerStarted).toBe(true);
				expect(promoteSawWriterPending).toBe(true);
				yield* Effect.promise(
					() => writerPromise ?? Promise.reject(new Error('writer did not start')),
				);

				const commands = readFileSync(join(target, COMMAND_CHANNEL_COMMANDS_FILE_NAME), 'utf8');
				expect(commands).toContain('"tag":"stack.start"');
				expect(commands).toContain('"tag":"shutdown.requested"');
				expect(commands.indexOf('"tag":"stack.start"')).toBeLessThan(
					commands.indexOf('"tag":"shutdown.requested"'),
				);
				expect(readFileSync(join(target, 'payload'), 'utf8')).toBe('new-content');
				expect(existsSync(backup)).toBe(false);
			}).pipe(Effect.provide(NodeFileSystem.layer)),
		),
	);

	it('StageAndSwapError is a tagged failure', () => {
		const err = new StageAndSwapError({
			stage: 'build',
			targetPath: '/x',
			stagingPath: '/y',
		});
		expect(err._tag).toBe('StageAndSwapError');
	});
});
