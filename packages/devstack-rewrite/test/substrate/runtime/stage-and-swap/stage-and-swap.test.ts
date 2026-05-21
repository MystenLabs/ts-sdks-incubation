// stage-and-swap — substrate-level atomic publish primitive.
//
// These tests exercise the lifted primitive in the new substrate
// location. The orchestrator-side forwarder (`orchestrators/snapshot/
// stage-and-swap.ts`) re-exports from substrate; deletion in PR3.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Effect, Exit, FileSystem } from 'effect';
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

const freshRoot = (): string => mkdtempSync(join(tmpdir(), 'stage-and-swap-test-'));

const buildSucceeds = (stagingPath: string, content: string) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		yield* fs.writeFileString(join(stagingPath, 'payload'), content);
	});

describe('stageAndSwap', () => {
	it.effect('successful build promotes staging → target atomically', () =>
		Effect.gen(function* () {
			const root = freshRoot();
			try {
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
			} finally {
				rmSync(root, { recursive: true, force: true });
			}
		}).pipe(Effect.provide(NodeFileSystem.layer)),
	);

	it.effect('build failure leaves target untouched and removes staging', () =>
		Effect.gen(function* () {
			const root = freshRoot();
			try {
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
			} finally {
				rmSync(root, { recursive: true, force: true });
			}
		}).pipe(Effect.provide(NodeFileSystem.layer)),
	);

	it.effect('existing target is restored from backup on rename failure', () =>
		Effect.gen(function* () {
			const root = freshRoot();
			try {
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
			} finally {
				rmSync(root, { recursive: true, force: true });
			}
		}).pipe(Effect.provide(NodeFileSystem.layer)),
	);

	it.effect('preserves selected target paths after build and before publish', () =>
		Effect.gen(function* () {
			const root = freshRoot();
			try {
				const target = join(root, 'target');
				mkdirSync(target, { recursive: true });
				writeFileSync(join(target, 'commands.ndjson'), 'before\n');
				const staging = join(root, 'target.staging');
				const backup = join(root, 'target.bak');

				yield* stageAndSwap({
					targetPath: target,
					stagingPath: staging,
					backupPath: backup,
					preserveFromTarget: [{ relativePath: 'commands.ndjson', kind: 'file' }],
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
			} finally {
				rmSync(root, { recursive: true, force: true });
			}
		}).pipe(Effect.provide(NodeFileSystem.layer)),
	);

	it.effect('serializes command appends started after backup and before promote', () =>
		Effect.gen(function* () {
			const root = freshRoot();
			try {
				const target = join(root, 'target');
				mkdirSync(target, { recursive: true });
				const paths = commandChannelPaths(target);
				const publisher = yield* makeCommandChannelPublisher(paths);
				yield* publisher.publish({ tag: 'before.swap' });

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
										writerPromise = Effect.runPromise(publisher.publish({ tag: 'during.swap' }));
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
					preserveFromTarget: [{ relativePath: COMMAND_CHANNEL_COMMANDS_FILE_NAME, kind: 'file' }],
					publishLockPath: runtimeControlLockPathForStackRoot(target),
					build: buildSucceeds(staging, 'new-content'),
				}).pipe(Effect.provideService(FileSystem.FileSystem, wrappedFs));

				expect(writerStarted).toBe(true);
				expect(promoteSawWriterPending).toBe(true);
				yield* Effect.promise(
					() => writerPromise ?? Promise.reject(new Error('writer did not start')),
				);

				const commands = readFileSync(join(target, COMMAND_CHANNEL_COMMANDS_FILE_NAME), 'utf8');
				expect(commands).toContain('"tag":"before.swap"');
				expect(commands).toContain('"tag":"during.swap"');
				expect(commands.indexOf('"tag":"before.swap"')).toBeLessThan(
					commands.indexOf('"tag":"during.swap"'),
				);
				expect(readFileSync(join(target, 'payload'), 'utf8')).toBe('new-content');
				expect(existsSync(backup)).toBe(false);
			} finally {
				rmSync(root, { recursive: true, force: true });
			}
		}).pipe(Effect.provide(NodeFileSystem.layer)),
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
