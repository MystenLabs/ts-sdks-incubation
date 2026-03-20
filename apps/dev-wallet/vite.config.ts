// Copyright (c) Mysten Labs, Inc.
// SPDX-License-Identifier: Apache-2.0

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

export default defineConfig({
	plugins: [forceSideEffects()],
	build: {
		outDir: 'dist',
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
