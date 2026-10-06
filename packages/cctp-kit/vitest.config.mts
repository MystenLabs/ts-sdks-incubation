// Copyright (c) Mysten Labs, Inc.
// SPDX-License-Identifier: Apache-2.0

import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		environment: 'node',
		globals: true,
		restoreMocks: true,
		testTimeout: 30000,
		hookTimeout: 30000,
	},
});
