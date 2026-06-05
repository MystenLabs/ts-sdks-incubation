import { readFileSync } from 'node:fs';

export const readDevstackVersion = (): string => {
	try {
		const raw = readFileSync(new URL('../../../package.json', import.meta.url), 'utf8');
		const pkg = JSON.parse(raw) as { readonly version?: unknown };
		return typeof pkg.version === 'string' ? pkg.version : '0.0.0';
	} catch {
		return '0.0.0';
	}
};
