import { defineConfig } from 'tsdown';

export default defineConfig({
	entry: ['src/index.ts', 'src/bin.ts'],
	format: 'esm',
	dts: true,
	outDir: 'dist',
	unbundle: true,
	treeshake: false,
	deps: {
		skipNodeModulesBundle: true,
	},
	platform: 'node',
	target: 'node22',
});
