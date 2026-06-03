// Ship the bundled DeepBook + sandbox-Pyth Move sources with the package.
//
// `deepbook({ mode: 'local' })` publishes these vendored Move trees during
// `devstack apply` (see src/plugins/deepbook/bootstrap-assets/index.ts). The
// source-of-truth tree lives under
// `src/plugins/deepbook/bootstrap-assets/move`; `tsdown` only emits `.ts`, so
// this step copies the Move tree to `<package-root>/move-assets/deepbook`,
// which the package `files` array ships and the runtime resolver reads.
//
// Invoked by the package `build` script (before `tsdown`) and standalone via
// `pnpm --filter @mysten-incubation/devstack build:deepbook-assets`.

import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const sourceTree = join(packageRoot, 'src', 'plugins', 'deepbook', 'bootstrap-assets', 'move');
const shippedTree = join(packageRoot, 'move-assets', 'deepbook');

const log = (msg) => {
	// eslint-disable-next-line no-console
	console.log(`[build:deepbook-assets] ${msg}`);
};

if (!existsSync(join(sourceTree, 'deepbookv3', 'deepbook', 'Move.toml'))) {
	throw new Error(
		`expected DeepBook Move sources at ${sourceTree}, but they are missing. ` +
			`The upstream deepbookv3 tree is fetched on demand — run ` +
			`\`pnpm --filter @mysten-incubation/devstack fetch:deepbook-move\` (or \`build:deepbook-assets\`, ` +
			`which fetches first).`,
	);
}

log(`copying ${sourceTree} → ${shippedTree}`);
rmSync(shippedTree, { recursive: true, force: true });
mkdirSync(dirname(shippedTree), { recursive: true });
cpSync(sourceTree, shippedTree, {
	recursive: true,
	// Skip Move build artifacts / locks and the fetch marker if any sneak in.
	filter: (src) =>
		!src.endsWith('Move.lock') &&
		!src.endsWith('Published.toml') &&
		!src.endsWith('.deepbookv3-rev') &&
		!src.includes(`${join('', 'build', '')}`),
});

log('done');
