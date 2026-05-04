// Copies `examples/_template/` into `packages/create-devstack-app/template/`
// at build time so the published package is self-contained. Skips generated
// dirs (`node_modules`, `dist`, `.devstack`, `.turbo`, build-tsbuildinfo).
//
// Run via `pnpm -F @mysten-incubation/create-devstack-app run sync-template`,
// or as part of `pnpm build` (the package script chains the two).

import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(HERE, '..');
const REPO_ROOT = resolve(PKG_ROOT, '..', '..');
const SRC = resolve(REPO_ROOT, 'examples', '_template');
const DST = resolve(PKG_ROOT, 'template');

if (!existsSync(SRC)) {
	throw new Error(`sync-template: source ${SRC} not found. The repo layout may have changed.`);
}

if (existsSync(DST)) {
	rmSync(DST, { recursive: true, force: true });
}
mkdirSync(DST, { recursive: true });

const SKIP = new Set([
	'node_modules',
	'dist',
	'.devstack',
	'.turbo',
	'tsconfig.app.tsbuildinfo',
	'tsconfig.node.tsbuildinfo',
]);

cpSync(SRC, DST, {
	recursive: true,
	filter: (s) => {
		const parts = s.split('/');
		for (const p of parts) {
			if (SKIP.has(p)) return false;
			if (/^.*\.config\.(js|d\.ts)$/.test(p)) return false;
		}
		return true;
	},
});

process.stdout.write(`synced ${SRC} → ${DST}\n`);
