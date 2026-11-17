// Copyright (c) Mysten Labs, Inc.
// SPDX-License-Identifier: Apache-2.0

import { defineConfig } from 'tsdown';

export default defineConfig({
	entry: [
		'src/index.ts',
		'src/exact/client/index.ts',
		'src/exact/server/index.ts',
		'src/exact/facilitator/index.ts',
	],
	format: ['esm'],
	dts: true,
	sourcemap: true,
});
