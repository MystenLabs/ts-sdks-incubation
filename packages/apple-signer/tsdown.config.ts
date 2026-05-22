// Copyright (c) Mysten Labs, Inc.
// SPDX-License-Identifier: Apache-2.0

import { defineConfig } from 'tsdown';

export default defineConfig({
	entry: ['src/index.ts', 'src/recover.ts'],
	format: 'esm',
	dts: true,
	outDir: 'dist',
	unbundle: true,
	treeshake: false,
	external: ['node-forge'],
});
