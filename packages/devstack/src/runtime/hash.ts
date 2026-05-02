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
	| Date
	| RegExp
	| Map<unknown, unknown>
	| Set<unknown>
	| JsonValue[]
	| { [key: string]: JsonValue };

/** Stable string representation. Beyond plain JSON: bigints serialise as
 * `<n>n`; Date/Map/Set/RegExp get explicit type-tagged forms so they don't
 * collide with `{}` (which is what `Object.entries` of any of them returns).
 * Cyclic graphs are short-circuited with a `__cycle` marker — without this,
 * a self-referential input stack-overflows. */
function stableStringify(value: unknown, seen: WeakSet<object>): string {
	if (value === undefined) return 'undefined';
	if (value === null) return 'null';
	if (typeof value === 'bigint') return `${value.toString()}n`;
	if (typeof value === 'number' || typeof value === 'boolean') return JSON.stringify(value);
	if (typeof value === 'string') return JSON.stringify(value);
	if (value instanceof Date) return `Date(${value.toISOString()})`;
	if (value instanceof RegExp) return `RegExp(${value.source},${value.flags})`;
	if (typeof value === 'object') {
		if (seen.has(value as object)) return '__cycle';
		seen.add(value as object);
		try {
			if (value instanceof Map) {
				const entries = [...value.entries()]
					.map(
						([k, v]) =>
							[stableStringify(k, seen), stableStringify(v, seen)] as [string, string],
					)
					.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
					.map(([k, v]) => `${k}:${v}`);
				return `Map{${entries.join(',')}}`;
			}
			if (value instanceof Set) {
				const items = [...value]
					.map((v) => stableStringify(v, seen))
					.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
				return `Set[${items.join(',')}]`;
			}
			if (Array.isArray(value)) {
				return `[${value.map((v) => stableStringify(v, seen)).join(',')}]`;
			}
			const entries = Object.entries(value as Record<string, unknown>)
				.filter(([, v]) => v !== undefined)
				.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
				.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v, seen)}`);
			return `{${entries.join(',')}}`;
		} finally {
			seen.delete(value as object);
		}
	}
	// functions, symbols → opaque marker (callers shouldn't put these in inputs)
	return `__nonjson:${typeof value}`;
}

export function stableHash(value: unknown): string {
	const h = createHash('sha256');
	h.update(stableStringify(value as JsonValue, new WeakSet()));
	return h.digest('hex');
}
