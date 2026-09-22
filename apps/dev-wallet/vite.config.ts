// Copyright (c) Mysten Labs, Inc.
// SPDX-License-Identifier: Apache-2.0

import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Plugin } from 'vite';
import { defineConfig } from 'vite';

/**
 * Marks all local source modules as having side effects so Rolldown
 * preserves Lit `@customElement()` decorator calls (which register
 * custom elements as a top-level side effect).
 */
function forceSideEffects(): Plugin {
	return {
		name: 'force-side-effects',
		transform(_code, id) {
			if (/\.[jt]sx?$/.test(id)) {
				// Mark all JS/TS files as having side effects, including
				// @mysten-incubation/dev-wallet which registers Lit custom elements
				return { moduleSideEffects: true };
			}
		},
	};
}

/**
 * Copy bookmarklet.js from the dev-wallet package build output into dist/.
 * Fails the build if it's missing — a deploy without it silently breaks the
 * Settings-tab bookmarklet.
 */
function copyBookmarklet(): Plugin {
	const src = resolve(
		import.meta.dirname,
		'../../packages/dev-wallet/dist/standalone/bookmarklet.js',
	);
	return {
		name: 'copy-bookmarklet',
		apply: 'build',
		closeBundle() {
			if (!existsSync(src)) {
				throw new Error(
					`Missing ${src}. Build the package first: pnpm turbo build --filter=@mysten-incubation/dev-wallet`,
				);
			}
			const dest = resolve(import.meta.dirname, 'dist/bookmarklet.js');
			mkdirSync(resolve(import.meta.dirname, 'dist'), { recursive: true });
			copyFileSync(src, dest);
		},
	};
}

export default defineConfig({
	plugins: [forceSideEffects(), copyBookmarklet()],
	build: {
		outDir: 'dist',
		// Single-page wallet bundle (Lit UI + Sui SDK); no benefit from splitting further.
		chunkSizeWarningLimit: 600,
	},
	server: {
		// Serve bookmarklet.js with CORS for local dev
		headers: {
			'Access-Control-Allow-Origin': '*',
		},
	},
	esbuild: {
		tsconfigRaw: {
			compilerOptions: {
				experimentalDecorators: true,
				useDefineForClassFields: false,
			},
		},
	},
	resolve: {
		conditions: ['import', 'module', 'browser', 'default'],
	},
});
