// Atomic file write helpers — write to a sibling tmp path then
// `rename(2)` over the target. POSIX guarantees rename is atomic on
// the same filesystem, so concurrent readers either see the prior
// content or the new content, never a half-written file.
//
// Without this, every reader of a hot-path sidecar (`manifest.json`,
// the traefik dynamic config, `.devstack/active`) is racing the
// supervisor's writer: a `readFileSync` mid-write yields an empty or
// truncated buffer, which then fails JSON.parse upstream.
//
// `fs.promises.writeFile` opens the destination O_TRUNC and writes in
// chunks, so it leaves the target empty for the duration of the I/O.

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as crypto from 'node:crypto';

/** Atomically write `body` to `target`. Creates the parent directory
 *  if missing. Sibling tmp file uses a random suffix so two concurrent
 *  writers don't fight for the same tmp path on the same filesystem. */
export const writeFileAtomic = async (
	target: string,
	body: string | Uint8Array,
	options?: { mode?: number },
): Promise<void> => {
	const dir = path.dirname(target);
	await fs.mkdir(dir, { recursive: true });
	const tmp = path.join(
		dir,
		`.${path.basename(target)}.tmp.${crypto.randomBytes(6).toString('hex')}`,
	);
	try {
		await fs.writeFile(tmp, body, options?.mode !== undefined ? { mode: options.mode } : undefined);
		await fs.rename(tmp, target);
	} catch (err) {
		await fs.unlink(tmp).catch(() => undefined);
		throw err;
	}
};

/** Like {@link writeFileAtomic} but skips the write entirely when the
 *  body matches what's already on disk. Returns `true` when a write
 *  happened, `false` when a no-op. Useful for hot-path emitters that
 *  don't want to thrash watchers (Vite HMR, Playwright's manifest
 *  re-read) on every tick. */
export const writeFileAtomicIfChanged = async (
	target: string,
	body: string,
	options?: { mode?: number },
): Promise<boolean> => {
	let existing: string | undefined;
	try {
		existing = await fs.readFile(target, 'utf-8');
	} catch {
		// missing — fall through and write
	}
	if (existing === body) return false;
	await writeFileAtomic(target, body, options);
	return true;
};
