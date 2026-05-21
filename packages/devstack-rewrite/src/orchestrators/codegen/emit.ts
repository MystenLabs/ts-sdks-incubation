// File emission: stage-and-swap atomic write + idempotent no-touch.
//
// Distilled-doc § "No-touch on no change": when inputs are unchanged,
// file mtimes do not move. This is load-bearing for dev-server HMR
// quietness — Vite watchers fire on mtime, not content.
//
// Flow per file:
//   1. Read existing file (best-effort). Decode as UTF-8 string.
//   2. Compare to rendered content. If identical, restore mode bits
//      (defensive — distilled-doc §"sensitive-file permission drift")
//      and return WITHOUT touching the file.
//   3. Otherwise atomic-write via the substrate's `atomicWriteFile`
//      primitive: tempfile + fsync + rename. Apply mode.
//
// The orchestrator's outer stage-and-swap (one staging dir per cycle,
// one rename promote — distilled-doc §"Atomic promotion") is layered
// ABOVE this per-file primitive. Per-file no-touch defends the
// staging dir's content; the outer rename promotes it to user-visible.

import { Effect, FileSystem } from 'effect';

import { atomicWriteFile } from '../../substrate/runtime/atomic-write.ts';

import { CodegenWriteFailed } from './errors.ts';

export interface EmitOneInput {
	readonly path: string;
	readonly content: string;
	readonly mode: number;
}

export interface EmitOneResult {
	readonly path: string;
	/** `wrote` — content was different and we atomically wrote.
	 *  `unchanged` — bytes matched, we skipped the write.
	 *  `chmod-only` — bytes matched but mode bits drifted; we
	 *  restored the mode but did not rewrite the file. */
	readonly outcome: 'wrote' | 'unchanged' | 'chmod-only';
}

/**
 * Emit one file with idempotency. The mode is re-applied even on
 * the no-write path to recover from manual chmods (distilled-doc
 * §"sensitive-file permission drift").
 */
export const emitOne = (
	input: EmitOneInput,
): Effect.Effect<EmitOneResult, CodegenWriteFailed, FileSystem.FileSystem> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const bytes = new TextEncoder().encode(input.content);

		// 1. Best-effort read of existing content for the no-touch
		//    short-circuit. A missing file collapses to "no existing
		//    bytes" → write. Any other error also collapses to write
		//    (atomic-write will report the real failure).
		const existing = yield* fs.readFileString(input.path).pipe(
			Effect.match({
				onSuccess: (text) => text,
				onFailure: () => null,
			}),
		);

		if (existing !== null && existing === input.content) {
			// Content matches — re-apply mode to fix drift, but don't
			// touch the file's mtime. `chmod` updates the inode's
			// `ctime` only.
			const drifted = yield* checkAndRestoreMode(input.path, input.mode);
			return {
				path: input.path,
				outcome: drifted ? ('chmod-only' as const) : ('unchanged' as const),
			};
		}

		// 2. Bytes differ (or file missing) — atomic write. The
		//    substrate's `atomicWriteFile` owns mkdir-parent +
		//    tempfile + fsync + rename. Mode is applied at create
		//    time via the `mode` open flag.
		yield* atomicWriteFile(input.path, bytes, { mode: input.mode }).pipe(
			Effect.mapError(
				(cause) =>
					new CodegenWriteFailed({
						outputPath: input.path,
						stage: cause.stage === 'mkdir-parent' ? 'mkdir-parent' : 'write',
						cause,
					}),
			),
		);
		return { path: input.path, outcome: 'wrote' as const };
	}).pipe(
		Effect.withSpan('codegen.emitOne', {
			attributes: { 'codegen.path': input.path },
		}),
	);

/**
 * Check the file's current mode and restore it if drifted. Returns
 * true if a chmod was performed.
 */
const checkAndRestoreMode = (
	path: string,
	wantedMode: number,
): Effect.Effect<boolean, CodegenWriteFailed, FileSystem.FileSystem> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const stat = yield* fs.stat(path).pipe(
			Effect.match({
				onSuccess: (s) => s,
				onFailure: () => null,
			}),
		);
		if (stat === null) return false;
		// `stat.mode` is the full mode bits; mask to file-perm
		// bits (lowest 12 — incl. setuid/setgid/sticky).
		const currentPermBits = stat.mode & 0o7777;
		if (currentPermBits === wantedMode) return false;
		yield* fs.chmod(path, wantedMode).pipe(
			Effect.mapError(
				(cause) =>
					new CodegenWriteFailed({
						outputPath: path,
						stage: 'chmod',
						cause,
					}),
			),
		);
		return true;
	});
