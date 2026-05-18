// Copyright (c) Mysten Labs, Inc.
// SPDX-License-Identifier: Apache-2.0

import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		environment: 'happy-dom',
		exclude: [
			'tests/browser-ui.test.ts',
			'tests/react.test.ts',
			// TODO: rework execFile mock for vitest 4 — promisify(execFile) captures
			// the real binding before vi.mock can swap it, so the suite shells out
			// to the real `sui` CLI on the host. Tracked as follow-up.
			'tests/cli-signing-middleware.test.ts',
			'node_modules/**',
			'examples/**',
		],
		hookTimeout: 120_000,
		testTimeout: 120_000,
	},
});
