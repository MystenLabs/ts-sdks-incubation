import { Effect } from 'effect';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { CodegenError } from './errors.js';

/** Idempotent write — read existing contents, skip the write if
 *  identical, and explicitly chmod afterwards (fs.writeFile's mode
 *  option only applies when creating the file). Used by emitters to
 *  avoid touching file mtimes on no-op regenerations. */
export const writeIfChanged = (
	outputPath: string,
	contents: string,
	options: { emitter: string; mode?: 0o600 | 0o644 },
): Effect.Effect<void, CodegenError> => {
	const mode = options.mode ?? 0o644;
	return Effect.tryPromise({
		try: async () => {
			await fs.mkdir(path.dirname(outputPath), { recursive: true });
			let existing: string | undefined;
			try {
				existing = await fs.readFile(outputPath, 'utf-8');
			} catch {
				// missing — fall through and write
			}
			if (existing !== contents) {
				await fs.writeFile(outputPath, contents, { encoding: 'utf-8', mode });
			}
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
