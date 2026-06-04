// Bundled DeepBook + sandbox-Pyth Move sources.
//
// `deepbook({ mode: 'local' })` with no explicit `package`/`pyth.package`
// publishes these vendored Move trees during `devstack apply`, so an app
// (or a scaffolded template) needs no sibling `deepbookv3` / `deepbook-sandbox`
// checkout and no hand-vendored `move/` directory.
//
// Asset-resolution pattern mirrors the dashboard SPA and `images/` bundle:
// the source-of-truth tree lives under `src/plugins/deepbook/bootstrap-assets/move`,
// and `pnpm build`'s `build:deepbook-assets` step copies it to
// `<package-root>/move-assets/deepbook` (shipped via the package `files` array).
// At runtime we resolve that shipped copy relative to the *dist* module; in the
// monorepo (tests / source runs) we fall back to the in-`src` tree.

import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

// In dist this module is `dist/plugins/deepbook/bootstrap-assets/index.mjs`;
// `../../../../` is the package root, where `build:deepbook-assets` drops the
// shipped `move-assets/deepbook` tree.
const SHIPPED_ROOT = resolve(HERE, '../../../../move-assets/deepbook');

// In the monorepo (source / vitest), the assets sit next to this module.
const SOURCE_ROOT = resolve(HERE, 'move');

/** Absolute path to the bundled Move asset root (shipped copy if present,
 *  else the in-source tree). */
export const deepbookMoveAssetRoot = (): string =>
	existsSync(resolve(SHIPPED_ROOT, 'deepbookv3', 'deepbook', 'Move.toml'))
		? SHIPPED_ROOT
		: SOURCE_ROOT;

/** Absolute path to a bundled Move package, verifying its `Move.toml` exists. */
export const deepbookMoveSource = (
	relativePath: 'deepbookv3/deepbook' | 'deepbook-sandbox/pyth',
): string => {
	const root = deepbookMoveAssetRoot();
	const sourcePath = resolve(root, relativePath);
	if (!existsSync(resolve(sourcePath, 'Move.toml'))) {
		throw new Error(
			`devstack deepbook: bundled Move package '${relativePath}' is missing at ${sourcePath}. ` +
				`Run \`pnpm --filter @mysten-incubation/devstack build:deepbook-assets\` (or \`pnpm build\`).`,
		);
	}
	return sourcePath;
};

/** Bundled DeepBook core package (publishes DEEP via its vendored `token` dep
 *  and captures registry / admin-cap / DEEP-treasury object ids). */
export const bundledDeepbookSource = (): string => deepbookMoveSource('deepbookv3/deepbook');

/** Bundled sandbox-Pyth package (local mock price feeds). */
export const bundledPythSource = (): string => deepbookMoveSource('deepbook-sandbox/pyth');
