// Stable hash of plain JSON values. Used by the reconciler to compute an
// input fingerprint per action (Q3 — helpers compute hashes from declared
// inputs). FS-side hashing (Move source files, dockerfiles) extends this in
// later phases by feeding additional content into the same `update()` flow.

import { createHash } from 'node:crypto';

type JsonValue =
	| string
	| number
	| boolean
	| null
	| bigint
	| undefined
	| JsonValue[]
	| { [key: string]: JsonValue };

/** Stable string representation: object keys sorted; bigints serialised as `<n>n`. */
function stableStringify(value: unknown): string {
	if (value === undefined) return 'undefined';
	if (value === null) return 'null';
	if (typeof value === 'bigint') return `${value.toString()}n`;
	if (typeof value === 'number' || typeof value === 'boolean') return JSON.stringify(value);
	if (typeof value === 'string') return JSON.stringify(value);
	if (Array.isArray(value)) {
		return `[${value.map((v) => stableStringify(v)).join(',')}]`;
	}
	if (typeof value === 'object') {
		const entries = Object.entries(value as Record<string, unknown>)
			.filter(([, v]) => v !== undefined)
			.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
			.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`);
		return `{${entries.join(',')}}`;
	}
	// functions, symbols → opaque marker (callers shouldn't put these in inputs)
	return `__nonjson:${typeof value}`;
}

export function stableHash(value: unknown): string {
	const h = createHash('sha256');
	h.update(stableStringify(value as JsonValue));
	return h.digest('hex');
}
