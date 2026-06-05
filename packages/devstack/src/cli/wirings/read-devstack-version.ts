import { readFileSync } from 'node:fs';

export const readDevstackVersion = (opts?: { readonly fallback?: string }): string => {
	try {
		const raw = readFileSync(new URL('../../../package.json', import.meta.url), 'utf8');
		const pkg = JSON.parse(raw) as { readonly version?: unknown };
		if (typeof pkg.version !== 'string') {
			throw new Error('devstack package.json is missing a string version');
		}
		return pkg.version;
	} catch (cause) {
		if (opts?.fallback !== undefined) return opts.fallback;
		throw cause;
	}
};
