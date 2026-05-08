import { defineConfig } from 'tsdown';

export default defineConfig({
	entry: ['src/index.ts'],
	format: 'esm',
	dts: true,
	outDir: 'dist',
	unbundle: true,
	treeshake: true,
	platform: 'node',
	target: 'node22',
	sourcemap: true,
});
