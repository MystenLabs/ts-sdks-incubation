import { defineConfig } from 'tsdown';

// `unbundle: true` preserves the source directory layout in `dist/`, so
// `import.meta.url` at runtime points at the same relative location it
// did during local source runs. Plugin actions that resolve sibling
// assets via `dirname(fileURLToPath(import.meta.url))` (`plugins/sui`,
// `plugins/seal`, …) keep working in published builds without an
// embed-as-string workaround.
//
// `copy` mirrors each plugin's non-source assets into the same path
// under `dist/` so the bundled `index.mjs` finds its Dockerfile +
// entrypoint.sh next to itself.
export default defineConfig({
	entry: [
		'src/index.ts',
		'src/playwright/index.ts',
		'src/playwright/global-setup.ts',
		'src/playwright/global-teardown.ts',
		'src/vite/plugin.ts',
		'src/vitest/index.ts',
		'src/vitest/runtime.ts',
		'src/cli/index.ts',
		'src/cli/apply.ts',
		'src/cli/codegen.ts',
		'src/cli.ts',
		'src/helpers.ts',
		'src/runtime.ts',
		'src/react/index.ts',
	],
	format: 'esm',
	dts: true,
	outDir: 'dist',
	unbundle: true,
	treeshake: false,
	platform: 'node',
	target: 'node22',
	sourcemap: true,
	external: [
		'@mysten/dapp-kit-core',
		'@mysten/dapp-kit-react',
		'@tanstack/react-query',
		'react',
		'react-dom',
	],
	copy: [
		{ from: 'src/plugins/sui/Dockerfile', to: 'dist/plugins/sui' },
		{ from: 'src/plugins/sui/entrypoint.sh', to: 'dist/plugins/sui' },
		{ from: 'src/plugins/seal/Dockerfile', to: 'dist/plugins/seal' },
	],
});
