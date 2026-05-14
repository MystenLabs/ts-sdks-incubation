import { mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Env, SnapshotRecord } from '../engine/types.js';
import { snapshotPathFor } from './paths.js';

// Atomic write — write to a temp sibling then rename onto the target path.
// Rename is atomic on the same filesystem (POSIX guarantee); a crash
// mid-write can leave a `.tmp-<rand>` orphan but never a torn snapshot.
export async function writeSnapshot(env: Env, record: SnapshotRecord): Promise<string> {
	return writeJsonAtomic(snapshotPathFor(env), record);
}

export async function writeJsonAtomic(path: string, value: unknown): Promise<string> {
	await mkdir(dirname(path), { recursive: true });
	const tmp = `${path}.tmp-${process.pid}-${Date.now()}-${randHex()}`;
	const body = JSON.stringify(value, null, 2);
	await writeFile(tmp, body, 'utf8');
	await rename(tmp, path);
	return path;
}

function randHex(): string {
	return Math.floor(Math.random() * 0xffff_ffff)
		.toString(16)
		.padStart(8, '0');
}
