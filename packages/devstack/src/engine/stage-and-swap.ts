// stageAndSwap — atomic directory replace primitive.
//
// Given a `target` directory and a `stage(tempDir)` Effect that fills a
// sibling staging dir, the primitive guarantees the consumer's `target`
// is ALWAYS either fully-old or fully-new. No partial state lands on
// disk, even when `stage` fails or the second rename trips.
//
// Pipeline:
//   1. create sibling staging dir: `<target>.staging-<pid>-<rand>`
//   2. invoke `stage(stagingDir)`              ← caller-supplied body
//   3. if `target` exists: rename → `<target>.backup-<pid>-<rand>`
//   4. rename staging → target
//   5. on success: rm backup (unless `keepBackup`)
//   6. on failure between (3)/(4): rename backup → target (rollback)
//      on failure during (2): rm staging; `target` left untouched.
//
// Cleanup runs on success, failure, AND interrupt via
// `Effect.acquireUseRelease`. POSIX rename(2) is atomic on the same
// filesystem; an external watcher (Vite HMR) attached to `target`
// therefore never observes a half-written tree.
//
// History: `services/codegen.ts` and `codegen/emitters/bindings.ts`
// each carried their own copy of this dance with subtly different
// rollback semantics — codegen restored the backup on second-rename
// failure, bindings just rm'd the staging dir. Centralizing both onto
// this primitive resolves the divergence in codegen's favor (rollback
// is the safer default for a tree a downstream consumer is reading).

import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { Effect, Schema } from 'effect';
import { stringifyCause } from './stringify-cause.js';

/** Failure modes surfaced by {@link stageAndSwap}. Carries the
 *  filesystem op that failed (`mkdir`, `rename-aside`, `rename-promote`,
 *  `cleanup`) so the caller can map it onto its own tagged error without
 *  losing diagnostic context. The `target` field is the consumer's
 *  outputDir — the operand that motivated the op. */
export class StageAndSwapError extends Schema.TaggedErrorClass<StageAndSwapError>()(
	'StageAndSwapError',
	{
		op: Schema.Literals(['mkdir', 'rename-aside', 'rename-promote', 'cleanup'] as const),
		target: Schema.String,
		message: Schema.String,
		cause: Schema.optional(Schema.Defect),
	},
) {}

export interface StageAndSwapOptions<E, R> {
	/** Target directory the staged contents replace. */
	readonly target: string;
	/** Effect that fills the staging dir. Receives the staging path;
	 *  returns when the staged tree is complete and ready to promote. */
	readonly stage: (stagingDir: string) => Effect.Effect<void, E, R>;
	/** Keep the previous target's contents around as
	 *  `<target>.backup-<suffix>` on success? Default: false (swap
	 *  drops the displaced tree). */
	readonly keepBackup?: boolean;
	/** Strict rename semantics: rename-into-place IS atomic on the same
	 *  filesystem. Default: true. When false, fall back to copy-then-rm
	 *  for cross-filesystem targets (rare). Logged as a warning so the
	 *  loss of atomicity is visible in supervisor traces. */
	readonly atomic?: boolean;
}

/** Stage-and-swap a directory atomically. See module comment for the
 *  full pipeline. Returns the absolute `target` path on success.
 *
 *  Errors surface as `StageAndSwapError` (for filesystem ops we own)
 *  or whatever the caller's `stage` Effect failed with (returned via
 *  the `E` channel — `stage` errors are NOT wrapped, so a caller's
 *  tagged error round-trips intact). */
export const stageAndSwap = <E, R>(
	opts: StageAndSwapOptions<E, R>,
): Effect.Effect<string, E | StageAndSwapError, R> =>
	Effect.gen(function* () {
		const target = opts.target;
		const keepBackup = opts.keepBackup ?? false;
		const atomic = opts.atomic ?? true;
		// Suffix carries pid + 6 random bytes so two stage-and-swap calls
		// against the same target from the same process don't collide on
		// either the staging or the backup dir name.
		const suffix = `${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
		const stagingDir = `${target}.staging-${suffix}`;
		const backupDir = `${target}.backup-${suffix}`;

		// Ensure the parent of `target` exists before we try to create
		// `stagingDir` as a sibling — otherwise mkdir below would surface
		// ENOENT instead of EEXIST, and the diagnostic would point at the
		// staging path rather than the missing parent.
		yield* Effect.tryPromise({
			try: () => fs.mkdir(path.dirname(target), { recursive: true }),
			catch: (cause) =>
				new StageAndSwapError({
					op: 'mkdir',
					target: path.dirname(target),
					message: `failed to create parent of ${target}: ${stringifyCause(cause)}`,
					cause,
				}),
		});

		// (1) + (2) under acquireUseRelease so a failure during the
		// caller's `stage` body removes the staging dir on interrupt /
		// error / defect, no matter how the body exits.
		yield* Effect.acquireUseRelease(
			Effect.tryPromise({
				try: async () => {
					// Pre-clear in case a previous suffix-collision left
					// debris (impossible with the rand suffix, but cheap
					// insurance for crash-and-restart scenarios).
					await fs.rm(stagingDir, { recursive: true, force: true });
					await fs.mkdir(stagingDir, { recursive: true });
				},
				catch: (cause) =>
					new StageAndSwapError({
						op: 'mkdir',
						target: stagingDir,
						message: `failed to create staging dir ${stagingDir}: ${stringifyCause(cause)}`,
						cause,
					}),
			}),
			() => opts.stage(stagingDir),
			(_, exit) =>
				// On `stage` failure, drop the staging tree and leave the
				// pre-existing `target` untouched. On success, the staging
				// dir is consumed by the rename below — but if for some
				// reason that rename hasn't happened yet (it runs after
				// this release), the cleanup here is a no-op because
				// `fs.rm({force: true})` tolerates ENOENT.
				exit._tag === 'Success'
					? Effect.void
					: Effect.promise(() =>
							fs.rm(stagingDir, { recursive: true, force: true }).catch(() => undefined),
						),
		);

		// (3) move existing target aside if present. Use `fs.access` over
		// `fs.stat` so we don't pay for a stat we don't need.
		const targetExists = yield* Effect.tryPromise({
			try: async () => {
				try {
					await fs.access(target);
					return true;
				} catch {
					return false;
				}
			},
			catch: () => false,
		}).pipe(Effect.orElseSucceed(() => false));

		if (targetExists) {
			yield* Effect.tryPromise({
				try: () => fs.rename(target, backupDir),
				catch: (cause) =>
					new StageAndSwapError({
						op: 'rename-aside',
						target,
						message: `failed to move existing ${target} aside: ${stringifyCause(cause)}`,
						cause,
					}),
			}).pipe(
				Effect.tapError(() =>
					// Best-effort: drop the staging dir if the aside-rename
					// fails. `target` is untouched.
					Effect.promise(() =>
						fs.rm(stagingDir, { recursive: true, force: true }).catch(() => undefined),
					),
				),
			);
		}

		// (4) promote staging into place. If `atomic: false` and we're
		// crossing filesystems, fall back to copy-then-rm with a warning.
		yield* Effect.tryPromise({
			try: () => fs.rename(stagingDir, target),
			catch: (cause) =>
				new StageAndSwapError({
					op: 'rename-promote',
					target,
					message: `failed to promote staging into ${target}: ${stringifyCause(cause)}`,
					cause,
				}),
		}).pipe(
			Effect.catchTag('StageAndSwapError', (err) =>
				Effect.gen(function* () {
					if (atomic) {
						// (6a) rollback: put the displaced tree back. Best-
						// effort — a failure here means BOTH the promote AND
						// the rollback failed, in which case the consumer's
						// `target` is missing and we surface the original
						// promote error.
						if (targetExists) {
							yield* Effect.promise(() =>
								fs.rename(backupDir, target).catch(() => undefined),
							);
						}
						yield* Effect.promise(() =>
							fs.rm(stagingDir, { recursive: true, force: true }).catch(() => undefined),
						);
						return yield* Effect.fail(err);
					}
					// Cross-fs fallback. `cp -r` then `rm -rf` is NOT atomic;
					// a watcher attached to `target` will observe partial
					// state for the duration of the copy. We warn loudly so
					// the loss of atomicity surfaces in supervisor traces.
					yield* Effect.logWarning(
						`stageAndSwap: rename failed (${err.message}); falling back to ` +
							`copy-then-rm — NOT atomic. Use a same-filesystem target to ` +
							`restore atomicity.`,
					);
					yield* Effect.tryPromise({
						try: async () => {
							await fs.cp(stagingDir, target, { recursive: true, force: true });
							await fs.rm(stagingDir, { recursive: true, force: true });
						},
						catch: (cause) =>
							new StageAndSwapError({
								op: 'rename-promote',
								target,
								message: `copy-then-rm fallback failed for ${target}: ${stringifyCause(cause)}`,
								cause,
							}),
					});
				}),
			),
		);

		// (5) drop the backup unless the caller asked us to keep it.
		// Best-effort: a stale backup is debris, not a correctness issue.
		if (targetExists && !keepBackup) {
			yield* Effect.tryPromise({
				try: () => fs.rm(backupDir, { recursive: true, force: true }),
				catch: (cause) =>
					new StageAndSwapError({
						op: 'cleanup',
						target: backupDir,
						message: `failed to remove backup ${backupDir}: ${stringifyCause(cause)}`,
						cause,
					}),
			}).pipe(Effect.ignore);
		}

		return target;
	}).pipe(Effect.withSpan('stageAndSwap', { attributes: { 'stage.target': opts.target } }));
