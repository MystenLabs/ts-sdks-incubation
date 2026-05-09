import { defineConfig } from 'tsdown';

export default defineConfig({
	entry: [
		'src/index.ts',
		'src/cli/index.ts',
		'src/cli/main.ts',
		'src/helpers/index.ts',
		'src/persistence/index.ts',
		'src/plugins/index.ts',
		'src/shapes/index.ts',
	],
	format: 'esm',
	dts: true,
	outDir: 'dist',
	unbundle: true,
	treeshake: true,
	platform: 'node',
	target: 'node22',
	sourcemap: true,
});
