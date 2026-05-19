import { Effect } from 'effect';
import * as fs from 'node:fs/promises';
import { writeFileAtomicIfChanged } from '../engine/atomic-write.js';
import { CodegenError } from './errors.js';

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
	return Effect.tryPromise({
		try: async () => {
			await writeFileAtomicIfChanged(outputPath, contents, { mode });
			// Explicit chmod: writeFileAtomicIfChanged only sets `mode` when
			// it actually writes; on a no-op (content unchanged) we still
			// want the perms to match the requested mode in case a previous
			// run left them wrong. Cheap on warm paths (one syscall).
			await fs.chmod(outputPath, mode);
		},
		catch: (cause) =>
			new CodegenError({
				emitter: options.emitter,
				phase: 'write',
				message: `failed to write ${outputPath}: ${String(cause)}`,
				cause,
			}),
	});
};
