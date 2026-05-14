import { defineConfig } from 'tsdown';

// `unbundle: true` preserves the source layout in `dist/`, so
// `import.meta.url` resolves the same relative locations at runtime as
// during local source runs. `copy:` mirrors plugin-owned static assets
// (Dockerfiles, entrypoints) into the matching `dist/` paths so plugins
// resolve them via `new URL('./<asset>', import.meta.url)` in both
// source and built outputs.
export default defineConfig({
	entry: [
		'src/index.ts',
		'src/cli/main.ts',
		'src/helpers/index.ts',
		'src/leasing/index.ts',
		'src/persistence/index.ts',
		'src/playwright/index.ts',
		'src/plugins/index.ts',
		'src/dapp-kit/index.ts',
		'src/shapes/index.ts',
		'src/vitest/index.ts',
	],
	format: 'esm',
	dts: true,
	outDir: 'dist',
	unbundle: true,
	treeshake: true,
	platform: 'node',
	target: 'node22',
	sourcemap: true,
	copy: [
		{ from: 'src/plugins/sui/docker/Dockerfile', to: 'dist/plugins/sui/docker' },
		{ from: 'src/plugins/sui/docker/entrypoint.sh', to: 'dist/plugins/sui/docker' },
		{ from: 'src/plugins/seal/docker/Dockerfile', to: 'dist/plugins/seal/docker' },
		{ from: 'src/plugins/walrus/docker/upstream.Dockerfile', to: 'dist/plugins/walrus/docker' },
		{ from: 'src/plugins/walrus/docker/wrapper.Dockerfile', to: 'dist/plugins/walrus/docker' },
		{ from: 'src/plugins/walrus/docker/deploy.sh', to: 'dist/plugins/walrus/docker' },
		{ from: 'src/plugins/walrus/docker/run.sh', to: 'dist/plugins/walrus/docker' },
	],
});
