// Copyright (c) Mysten Labs, Inc.
// SPDX-License-Identifier: Apache-2.0

import { defineConfig } from 'tsdown';

export default defineConfig({
	entry: [
		'src/index.ts',
		'src/appkit.ts',
		'src/web/index.ts',
		'src/react/index.ts',
		'src/react/ui.ts',
	],
	format: ['esm'],
	dts: true,
	sourcemap: true,
});
