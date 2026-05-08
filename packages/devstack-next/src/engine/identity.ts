import { createHash } from 'node:crypto';

export function canonicalize(value: unknown): string {
	if (value === undefined || value === null) return 'null';
	if (typeof value === 'number') return Number.isFinite(value) ? JSON.stringify(value) : 'null';
	if (typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
	if (typeof value === 'bigint') return JSON.stringify(value.toString());
	if (Array.isArray(value)) {
		return '[' + value.map(canonicalize).join(',') + ']';
	}
	if (typeof value === 'object') {
		const obj = value as Record<string, unknown>;
		const keys = Object.keys(obj).sort();
		const parts: string[] = [];
		for (const key of keys) {
			const v = obj[key];
			if (v === undefined) continue;
			parts.push(JSON.stringify(key) + ':' + canonicalize(v));
		}
		return '{' + parts.join(',') + '}';
	}
	return JSON.stringify(String(value));
}

export function hash(value: unknown): string {
	return createHash('sha256').update(canonicalize(value)).digest('hex');
}

export function computeInputHash(args: {
	upstreamIdentities: readonly string[];
	ownInputs: unknown;
}): string {
	return hash({ upstream: args.upstreamIdentities, own: args.ownInputs });
}
