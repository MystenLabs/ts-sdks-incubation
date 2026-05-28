// Atomic stage-and-swap primitive.
//
// Architecture §"Stage-and-swap rollback discipline is precious and
// well-tested": one tempdir, one rename for the whole publish.
// Lifted to substrate so both snapshot AND codegen (per-cycle outer
// swap) can consume — see ARCHITECTURE.md substrate roster + style
// guide §19 (Open slot O14 closes with this lift).
//
// Contract:
//   1. The caller provides a `targetPath` (the directory to publish).
//   2. The orchestrator runs the build effect with a `stagingPath`
//      (a sibling under the same parent so the rename stays on the
//      same filesystem — POSIX rename atomicity is per-filesystem).
//   3. If the build effect succeeds AND the rename succeeds, the
//      target now points at the new tree; external watchers never
//      observed a half-written intermediate.
//   4. Optional `preserveFromTarget` paths are copied from the backed-up
//      target into staging immediately before publish.
//   5. On any failure the staging directory is removed; the previous
//      target (if any) is restored verbatim from a same-parent
//      backup.
//   6. Cross-filesystem fallback (`EXDEV` from rename) logs and falls
//      back to copy-then-rm — the architecture's documented exception.
//
// Discipline carried verbatim from the legacy `engine/snapshot/stage-
// and-swap.ts` (distilled §17).

import { dirname, isAbsolute, join, normalize, sep } from 'node:path';

import { Effect, FileSystem, Schema } from 'effect';

import { acquireStackLock } from '../cross-process/stack-lock.ts';
import { SpanAttr } from '../observability/spans.ts';

// -----------------------------------------------------------------------------
// Errors
// -----------------------------------------------------------------------------

/** Tagged failure during a stage-and-swap step. `stage` discriminates
 *  the precise failing step; the caller's underlying tag is preserved
 *  via `cause` (the primitive does NOT wrap the user's error). */
export class StageAndSwapError extends Schema.TaggedErrorClass<StageAndSwapError>()(
	'StageAndSwapError',
	{
		stage: Schema.Literals([
			'mkdir-staging',
			'mkdir-backup',
			'build',
			'acquire-publish-lock',
			'backup-current',
			'preserve-target-paths',
			'rename-into-target',
			'restore-backup',
			'cleanup-staging',
			'cross-filesystem-fallback',
		]),
		targetPath: Schema.String,
		stagingPath: Schema.String,
		cause: Schema.optional(Schema.Defect),
	},
) {}

// -----------------------------------------------------------------------------
// Primitive
// -----------------------------------------------------------------------------

export interface StageAndSwapPreservedPath {
	readonly relativePath: string;
	readonly kind: 'file' | 'directory';
}

const failStage =
	<S extends StageAndSwapError['stage']>(
		stage: S,
		targetPath: string,
		stagingPath: string,
	): ((cause: unknown) => Effect.Effect<never, StageAndSwapError>) =>
	(cause) =>
		Effect.fail(new StageAndSwapError({ stage, targetPath, stagingPath, cause }));

const normalizePreservedRelativePath = (relativePath: string): string | null => {
	const normalized = normalize(relativePath);
	if (
		relativePath.length === 0 ||
		isAbsolute(relativePath) ||
		normalized === '.' ||
		normalized === '..' ||
		normalized.startsWith(`..${sep}`)
	) {
		return null;
	}
	return normalized;
};

const preserveTargetPaths = (args: {
	readonly backupPath: string;
	readonly targetPath: string;
	readonly stagingPath: string;
	readonly preservedPaths: ReadonlyArray<StageAndSwapPreservedPath>;
}): Effect.Effect<void, StageAndSwapError, FileSystem.FileSystem> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		for (const preserved of args.preservedPaths) {
			const relativePath = normalizePreservedRelativePath(preserved.relativePath);
			if (relativePath === null) {
				return yield* failStage(
					'preserve-target-paths',
					args.targetPath,
					args.stagingPath,
				)(new Error(`unsafe preserved path: ${preserved.relativePath}`));
			}
			const source = join(args.backupPath, relativePath);
			const exists = yield* fs.exists(source).pipe(Effect.catch(() => Effect.succeed(false)));
			if (!exists) continue;
			const target = join(args.stagingPath, relativePath);
			yield* fs
				.makeDirectory(dirname(target), { recursive: true })
				.pipe(Effect.catch(failStage('preserve-target-paths', args.targetPath, args.stagingPath)));
			yield* fs
				.copy(source, target, { overwrite: true })
				.pipe(Effect.catch(failStage('preserve-target-paths', args.targetPath, args.stagingPath)));
		}
	});

/**
 * Build-then-swap. `build` is a user effect that populates `stagingPath`;
 * on success the helper:
 *
 *   - backs up the current `targetPath` (if any) to `<targetPath>.bak.<pid>`,
 *   - copies any selected `preserveFromTarget` paths from that backup
 *     into staging,
 *   - renames `stagingPath` → `targetPath`,
 *   - removes the backup.
 *
 * On any failure the helper removes `stagingPath` and, if the backup
 * was taken, renames it back to `targetPath` so the world looks
 * exactly as it did at entry.
 *
 * The build effect's error type passes through unchanged — the
 * primitive returns `E | StageAndSwapError`. This is the
 * "preserve the caller's error tag" rule from distilled §17.
 *
 * IMPORTANT: stagingPath MUST be on the same filesystem as
 * targetPath. The helper picks it as a sibling under the same parent
 * (caller passes `parentDir`, we mint the names) — this is enforced
 * by the helper's signature shape.
 *
 * ## Two call shapes
 *
 *   - Explicit-paths: callers that need bespoke sibling names (the
 *     Seal plugin uses `.backup.` not `.bak.`; pre-existing tests use
 *     literal `target.staging`/`target.bak`) pass both `stagingPath`
 *     and `backupPath` directly.
 *   - `idSuffix`: callers (codegen, snapshot) pass `idSuffix` and the
 *     primitive mints `<targetPath>.staging.<idSuffix>` /
 *     `<targetPath>.bak.<idSuffix>` so the staging/backup-naming
 *     convention is owned in ONE place. Callers MUST NOT pass both
 *     `idSuffix` and explicit paths.
 *
 * ## `preserveOnPreseed`
 *
 * When `true`, before the user's `build` runs the primitive copies the
 * current `targetPath` (if any) into `stagingPath` so `build` can
 * mutate that baseline incrementally. This subsumes the codegen
 * orchestrator's pre-seed dance (per-file no-touch idempotency relies
 * on seeing the previous target's mtimes). Cross-cutting with
 * `preserveFromTarget` is allowed: pre-seed clones the whole tree
 * BEFORE the build; `preserveFromTarget` cherry-picks paths AFTER the
 * build and BEFORE the swap (and reads from the backup, so the build
 * may have rewritten them in-tree). The two features answer different
 * questions and the primitive runs them in that order.
 */
export const stageAndSwap = <A, E>(
	args: {
		readonly targetPath: string;
		readonly build: Effect.Effect<A, E, FileSystem.FileSystem>;
		readonly preserveFromTarget?: ReadonlyArray<StageAndSwapPreservedPath>;
		readonly preserveOnPreseed?: boolean;
		readonly publishLockPath?: string;
	} & (
		| { readonly stagingPath: string; readonly backupPath: string; readonly idSuffix?: never }
		| { readonly idSuffix: string; readonly stagingPath?: never; readonly backupPath?: never }
	),
): Effect.Effect<A, E | StageAndSwapError, FileSystem.FileSystem> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const {
			targetPath,
			build,
			preserveFromTarget = [],
			preserveOnPreseed = false,
			publishLockPath,
		} = args;
		const stagingPath =
			args.stagingPath ?? `${targetPath}.staging.${(args as { idSuffix: string }).idSuffix}`;
		const backupPath =
			args.backupPath ?? `${targetPath}.bak.${(args as { idSuffix: string }).idSuffix}`;
		yield* Effect.annotateCurrentSpan({
			'devstack.stage-and-swap.target': targetPath,
			'devstack.stage-and-swap.staging': stagingPath,
		});

		// 0. Pre-clean the staging slot (a previous crash may have left
		//    a sibling). recursive+force is idempotent.
		yield* fs.remove(stagingPath, { recursive: true, force: true }).pipe(Effect.ignore);
		yield* fs
			.makeDirectory(stagingPath, { recursive: true })
			.pipe(Effect.catch(failStage('mkdir-staging', targetPath, stagingPath)));

		// 0a. Optional pre-seed: when `preserveOnPreseed`, clone the
		//     current target into staging so the build can edit it
		//     incrementally (codegen needs this for per-file no-touch
		//     idempotency). `preserveTimestamps: true` keeps mtimes
		//     intact so HMR watchers (Vite/Turbopack — they trigger on
		//     mtime, not content) stay quiet for unchanged outputs.
		if (preserveOnPreseed) {
			const targetExistsForPreseed = yield* fs
				.exists(targetPath)
				.pipe(Effect.catch(() => Effect.succeed(false)));
			if (targetExistsForPreseed) {
				yield* fs
					.copy(targetPath, stagingPath, { overwrite: true, preserveTimestamps: true })
					.pipe(
						Effect.catch(failStage('mkdir-staging', targetPath, stagingPath)),
						Effect.onError(() =>
							fs.remove(stagingPath, { recursive: true, force: true }).pipe(Effect.ignore),
						),
					);
			}
		}

		// 1. Run the user's build inside the staging directory. On
		//    failure clean up the staging dir (best-effort) BEFORE
		//    re-raising — preserves the caller's error tag (no wrap).
		const result = yield* build.pipe(
			Effect.onError(() =>
				fs.remove(stagingPath, { recursive: true, force: true }).pipe(Effect.ignore),
			),
		);

		// 2. Backup the current target and promote staging while holding
		//    an optional caller-supplied lock. Restore uses this to block
		//    command/event writers while the stack root path is absent.
		const targetExists = yield* Effect.scoped(
			Effect.gen(function* () {
				if (publishLockPath !== undefined) {
					yield* acquireStackLock(publishLockPath).pipe(
						Effect.catch(failStage('acquire-publish-lock', targetPath, stagingPath)),
					);
				}

				const targetExists = yield* fs
					.exists(targetPath)
					.pipe(Effect.catch(() => Effect.succeed(false)));
				if (targetExists) {
					// Move current → backup (atomic rename on same filesystem).
					yield* fs
						.rename(targetPath, backupPath)
						.pipe(Effect.catch(failStage('backup-current', targetPath, stagingPath)));
					yield* preserveTargetPaths({
						backupPath,
						targetPath,
						stagingPath,
						preservedPaths: preserveFromTarget,
					}).pipe(
						Effect.catch((error) =>
							Effect.gen(function* () {
								yield* fs
									.rename(backupPath, targetPath)
									.pipe(Effect.catch(failStage('restore-backup', targetPath, stagingPath)));
								return yield* Effect.fail(error);
							}),
						),
					);
				}

				// 3. Promote staging → target. This is the atomic publish step.
				yield* fs.rename(stagingPath, targetPath).pipe(
					Effect.catch((cause) => {
						const code = (cause as NodeJS.ErrnoException).code;
						if (code === 'EXDEV') {
							// Cross-filesystem fallback — architecture's documented
							// exception. Log loudly; copy then rm. The atomicity
							// guarantee is LOST in this branch.
							return Effect.gen(function* () {
								yield* Effect.logWarning('stage-and-swap cross-filesystem fallback').pipe(
									Effect.annotateLogs({
										[SpanAttr.stageAndSwapTargetPath]: targetPath,
										[SpanAttr.stageAndSwapStagingPath]: stagingPath,
										[SpanAttr.errorCode]: 'EXDEV',
									}),
								);
								yield* fs
									.copy(stagingPath, targetPath, { overwrite: false })
									.pipe(
										Effect.catch(failStage('cross-filesystem-fallback', targetPath, stagingPath)),
									);
								yield* fs.remove(stagingPath, { recursive: true, force: true }).pipe(Effect.ignore);
							});
						}
						// Same-filesystem rename failed. Restore backup if we took
						// one; surface the original tag.
						return Effect.gen(function* () {
							if (targetExists) {
								yield* fs
									.rename(backupPath, targetPath)
									.pipe(Effect.catch(failStage('restore-backup', targetPath, stagingPath)));
							}
							return yield* failStage('rename-into-target', targetPath, stagingPath)(cause);
						});
					}),
				);

				return targetExists;
			}),
		);

		// 4. Drop the backup. Failure here is observable but non-fatal:
		//    the new target is live; an orphan backup is cosmetic.
		if (targetExists) {
			yield* fs.remove(backupPath, { recursive: true, force: true }).pipe(Effect.ignore);
		}

		return result;
	}).pipe(Effect.withSpan('substrate.stage-and-swap'));
