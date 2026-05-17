// Copyright (c) Mysten Labs, Inc.
// SPDX-License-Identifier: Apache-2.0

import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		exclude: ['tests/browser-ui.test.ts', 'tests/react.test.ts', 'node_modules/**', 'examples/**'],
		hookTimeout: 120_000,
		testTimeout: 120_000,
		// Node 22+ exposes a built-in `localStorage` global via a getter
		// that survives happy-dom's window install — the getter returns a
		// stub (no `clear`/`removeItem`/etc methods) unless Node was
		// started with `--localstorage-file=<path>`. `setupFiles` runs
		// AFTER the env is built but BEFORE each test file's imports, so
		// it gets to overwrite `globalThis.localStorage` with happy-dom's
		// fully-implemented storage. The setup is a no-op in `node`-env
		// test files where `globalThis.window` is undefined.
		setupFiles: ['tests/setup-happy-dom.ts'],
	},
});
