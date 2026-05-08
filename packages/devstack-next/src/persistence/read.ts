import { readFile } from 'node:fs/promises';
import type { Env, SnapshotRecord } from '../engine/types.js';
import { snapshotPathFor } from './paths.js';

// Read a SnapshotRecord from disk. Returns undefined if the file does not
// exist (cold start). Throws on parse errors — a malformed snapshot is a
// loud failure, not a silent reset, so the user can investigate.
export async function tryReadSnapshot(env: Env): Promise<SnapshotRecord | undefined> {
	const path = snapshotPathFor(env);
	let raw: string;
	try {
		raw = await readFile(path, 'utf8');
	} catch (err) {
		if (isNotFound(err)) return undefined;
		throw err;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (err) {
		throw new Error(`failed to parse snapshot at ${path}: ${(err as Error).message}`);
	}
	if (!isSnapshotRecord(parsed)) {
		throw new Error(`snapshot at ${path} is missing required fields (createdAt, env, nodeStates)`);
	}
	return parsed;
}

function isNotFound(err: unknown): boolean {
	if (typeof err !== 'object' || err === null) return false;
	const code = (err as { code?: string }).code;
	return code === 'ENOENT';
}

function isSnapshotRecord(value: unknown): value is SnapshotRecord {
	if (typeof value !== 'object' || value === null) return false;
	const v = value as Record<string, unknown>;
	if (typeof v.createdAt !== 'number') return false;
	if (typeof v.env !== 'object' || v.env === null) return false;
	if (typeof v.nodeStates !== 'object' || v.nodeStates === null) return false;
	return true;
}
