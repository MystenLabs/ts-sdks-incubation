import { Effect } from 'effect';
import * as fs from 'node:fs/promises';
import { writeFileAtomicIfChanged } from '../engine/atomic-write.js';
import { stringifyCause } from '../engine/stringify-cause.js';
import type { CodegenPhase } from '../engine/phases.js';
import { CodegenError } from './errors.js';

/** Curry a `() => Promise<T>` into an `Effect<T, CodegenError>`, mapping
 *  any thrown cause to a `CodegenError` tagged with the supplied
 *  emitter + phase. Replaces the per-callsite `Effect.tryPromise({ try,
 *  catch: cause => new CodegenError(...) })` lattice that emitters
 *  previously repeated for every fs op.
 *
 *  `message` is the human-readable summary that gets `: <stringifyCause>`
 *  appended; `cause` is threaded into the structured error so the top-
 *  level pretty-error walker still sees the underlying defect. */
export const fsOp = <T>(
	opts: { readonly emitter: string; readonly phase: CodegenPhase; readonly message: string },
	body: () => Promise<T>,
): Effect.Effect<T, CodegenError> =>
	Effect.tryPromise({
		try: body,
		catch: (cause) =>
			new CodegenError({
				emitter: opts.emitter,
				phase: opts.phase,
				message: `${opts.message}: ${stringifyCause(cause)}`,
				cause,
			}),
	});

/** Idempotent write — read existing contents, skip the write if
 *  identical, and explicitly chmod afterwards (fs.writeFile's mode
 *  option only applies when creating the file). Used by emitters to
 *  avoid touching file mtimes on no-op regenerations.
 *
 *  Thin Effect+CodegenError wrapper around `writeFileAtomicIfChanged`
 *  in `engine/atomic-write.ts` — the canonical impl. The underlying
 *  helper handles parent-dir mkdir, the existing-content read,
 *  atomic write via sibling-tmp + rename, and the no-op short-circuit.
 *  Emitters use this wrapper so writes are atomic AND tagged with the
 *  emitter name for `CodegenError`'s phase tracking. */
export const writeIfChanged = (
	outputPath: string,
	contents: string,
	options: { emitter: string; mode?: 0o600 | 0o644 },
): Effect.Effect<void, CodegenError> => {
	const mode = options.mode ?? 0o644;
	return fsOp(
		{ emitter: options.emitter, phase: 'write', message: `failed to write ${outputPath}` },
		async () => {
			await writeFileAtomicIfChanged(outputPath, contents, { mode });
			// Explicit chmod: writeFileAtomicIfChanged only sets `mode` when
			// it actually writes; on a no-op (content unchanged) we still
			// want the perms to match the requested mode in case a previous
			// run left them wrong. Cheap on warm paths (one syscall).
			await fs.chmod(outputPath, mode);
		},
	);
};
