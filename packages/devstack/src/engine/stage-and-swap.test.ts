// stageAndSwap unit tests. Covers the four states promised by the
// primitive's docstring:
//   - happy path: backup is dropped on success.
//   - keepBackup: previous target survives as a sibling on success.
//   - stage failure: pre-existing target survives untouched, staging
//     dir cleaned up.
//   - promote-rename failure between (3)/(4): rollback restores the
//     pre-existing target from the backup.

import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Cause, Effect, Exit, Option } from 'effect';
import { afterEach, beforeEach, describe, expect } from 'vitest';
import { it } from '@effect/vitest';
import { stageAndSwap, StageAndSwapError } from './stage-and-swap.js';

describe('stageAndSwap', () => {
	let workDir: string;
	let target: string;

	beforeEach(() => {
		workDir = mkdtempSync(join(tmpdir(), 'devstack-stage-and-swap-'));
		target = join(workDir, 'out');
	});

	afterEach(() => {
		rmSync(workDir, { recursive: true, force: true });
	});

	const stagedSiblings = (): ReadonlyArray<string> => {
		const parent = dirname(target);
		if (!existsSync(parent)) return [];
		return readdirSync(parent).filter(
			(e) => e.startsWith('out.staging-') || e.startsWith('out.backup-'),
		);
	};

	it.effect('happy path: writes target, drops the staging+backup siblings', () =>
		Effect.gen(function* () {
			// Pre-existing content so a backup IS created. The default is
			// `keepBackup: false`, so the backup must be gone post-success.
			mkdirSync(target);
			writeFileSync(join(target, 'old.txt'), 'old', 'utf-8');

			yield* stageAndSwap({
				target,
				stage: (staging) =>
					Effect.promise(async () => {
						await fs.writeFile(join(staging, 'new.txt'), 'new', 'utf-8');
					}),
			});

			expect(existsSync(join(target, 'new.txt'))).toBe(true);
			expect(readFileSync(join(target, 'new.txt'), 'utf-8')).toBe('new');
			expect(existsSync(join(target, 'old.txt'))).toBe(false);
			expect(stagedSiblings()).toEqual([]);
		}),
	);

	it.effect('keepBackup: previous target survives as a sibling', () =>
		Effect.gen(function* () {
			mkdirSync(target);
			writeFileSync(join(target, 'old.txt'), 'old', 'utf-8');

			yield* stageAndSwap({
				target,
				keepBackup: true,
				stage: (staging) =>
					Effect.promise(async () => {
						await fs.writeFile(join(staging, 'new.txt'), 'new', 'utf-8');
					}),
			});

			expect(readFileSync(join(target, 'new.txt'), 'utf-8')).toBe('new');

			const backups = readdirSync(dirname(target)).filter((e) => e.startsWith('out.backup-'));
			expect(backups).toHaveLength(1);
			// Backup carries the pre-swap contents verbatim.
			expect(readFileSync(join(dirname(target), backups[0]!, 'old.txt'), 'utf-8')).toBe('old');

			// No staging dir leftover.
			const stagings = readdirSync(dirname(target)).filter((e) => e.startsWith('out.staging-'));
			expect(stagings).toEqual([]);
		}),
	);

	it.effect('stage failure: pre-existing target untouched, staging dir cleaned', () =>
		Effect.gen(function* () {
			mkdirSync(target);
			writeFileSync(join(target, 'old.txt'), 'preserve-me', 'utf-8');

			const exit = yield* Effect.exit(
				stageAndSwap({
					target,
					stage: () => Effect.fail('boom' as const),
				}),
			);

			expect(exit._tag).toBe('Failure');
			// Target is the pre-existing tree, byte-identical. The
			// primitive must NOT have moved it aside (or if it did, must
			// have put it back).
			expect(readFileSync(join(target, 'old.txt'), 'utf-8')).toBe('preserve-me');
			expect(stagedSiblings()).toEqual([]);
		}),
	);

	it.effect('promote-rename failure rolls back to the pre-existing target', () =>
		Effect.gen(function* () {
			mkdirSync(target);
			writeFileSync(join(target, 'survive.txt'), 'rollback-me', 'utf-8');

			// Make the second rename fail by removing the staging dir
			// from inside the stage body — `stage()` returns success but
			// the dir is gone, so `fs.rename(staging, target)` later
			// surfaces ENOENT. This forces the failure to land BETWEEN
			// the aside-rename (which already moved the original) and
			// the promote-rename; the rollback path then has to restore.
			const exit = yield* Effect.exit(
				stageAndSwap({
					target,
					stage: (staging) =>
						Effect.promise(async () => {
							await fs.rm(staging, { recursive: true, force: true });
						}),
				}),
			);

			expect(exit._tag).toBe('Failure');
			// The pre-existing target must be restored byte-identical.
			// Without rollback the consumer would observe a missing
			// `target` here, which is the bug this primitive exists to
			// prevent.
			expect(existsSync(target)).toBe(true);
			expect(readFileSync(join(target, 'survive.txt'), 'utf-8')).toBe('rollback-me');
			// And no backup or staging sibling left behind.
			expect(stagedSiblings()).toEqual([]);
		}),
	);

	it.effect('stage failure surfaces the caller-supplied error verbatim', () =>
		Effect.gen(function* () {
			const exit = yield* Effect.exit(
				stageAndSwap({
					target,
					stage: () => Effect.fail('caller-tag' as const),
				}),
			);

			expect(Exit.isFailure(exit)).toBe(true);
			if (Exit.isFailure(exit)) {
				// The `stage` error must NOT have been wrapped in
				// StageAndSwapError — callers want to round-trip their
				// own tagged errors. `Cause.findErrorOption` walks the
				// cause tree for the first typed failure; we expect the
				// caller's tag, not a primitive wrapper.
				const cause = (exit as unknown as { cause: Cause.Cause<unknown> }).cause;
				const opt = Cause.findErrorOption(cause);
				expect(Option.isSome(opt)).toBe(true);
				if (Option.isSome(opt)) {
					expect(opt.value).toBe('caller-tag');
					expect(opt.value).not.toBeInstanceOf(StageAndSwapError);
				}
			}
		}),
	);

	it.effect('absent pre-existing target: success creates target, no rollback needed', () =>
		Effect.gen(function* () {
			// `target` doesn't exist yet — must NOT touch any backup,
			// must just promote the staging dir into place.
			yield* stageAndSwap({
				target,
				stage: (staging) =>
					Effect.promise(async () => {
						await fs.writeFile(join(staging, 'fresh.txt'), 'fresh', 'utf-8');
					}),
			});

			expect(readFileSync(join(target, 'fresh.txt'), 'utf-8')).toBe('fresh');
			expect(stagedSiblings()).toEqual([]);
		}),
	);

	it('StageAndSwapError is a tagged error with op + target diagnostic fields', () => {
		const err = new StageAndSwapError({
			op: 'rename-promote',
			target: '/tmp/example',
			message: 'oops',
		});
		expect(err._tag).toBe('StageAndSwapError');
		expect(err.op).toBe('rename-promote');
		expect(err.target).toBe('/tmp/example');
	});
});
