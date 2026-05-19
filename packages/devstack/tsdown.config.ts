import { defineConfig } from 'tsdown';

// Main library + CLI bin. `dts: true` bundles types per-file.
// `copy:` mirrors plugin-owned static assets (Dockerfiles, entrypoints)
// into matching `dist/` paths so primitives resolve them via
// `new URL('../../<asset>/', import.meta.url)` in both source and built
// outputs.
const main = defineConfig({
	entry: ['src/index.ts', 'src/cli/main.ts', 'src/advanced/index.ts'],
	format: 'esm',
	dts: true,
	outDir: 'dist',
	unbundle: true,
	treeshake: true,
	platform: 'node',
	target: 'node22',
	sourcemap: true,
	copy: [
		{ from: 'seal-image/Dockerfile', to: 'dist/seal-image' },
		{ from: 'sui-image/Dockerfile', to: 'dist/sui-image' },
		{ from: 'sui-image/entrypoint.sh', to: 'dist/sui-image' },
		{ from: 'walrus-image/upstream.Dockerfile', to: 'dist/walrus-image' },
		{ from: 'walrus-image/wrapper.Dockerfile', to: 'dist/walrus-image' },
		{ from: 'walrus-image/deploy.sh', to: 'dist/walrus-image' },
		{ from: 'walrus-image/run.sh', to: 'dist/walrus-image' },
	],
});

// Test fixtures + dapp-kit browser subpath. `dts: false` here because
// rolldown-plugin-dts chokes on @effect/vitest's transitive postcss
// types when bundling (and on @mysten/dapp-kit-react's postcss types
// transitively pulled in via dapp-kit-core peers): it emits
// `Export 'AcceptedPlugin' is not defined` while parsing postcss's
// own d.mts. We sidestep the bundler by emitting these subpaths' dts
// with a separate `tsc --emitDeclarationOnly` step driven by
// `tsconfig.subpaths.json` (see the `build:dts-subpaths` script in
// package.json).
//
// **Re-investigate periodically:** check the rolldown-plugin-dts
// release notes on every quarterly dependency bump. When the postcss
// export-resolution bug is fixed upstream we can:
//   1. flip `dts: true` here,
//   2. delete `tsconfig.subpaths.json` + `scripts/finalize-subpath-dts.ts`,
//   3. drop the `build:dts-subpaths` script from package.json.
// Track at https://github.com/rolldown/rolldown — search for issues
// matching "AcceptedPlugin" or "postcss d.mts" before re-attempting.
const fixtures = defineConfig({
	entry: [
		'src/vitest/index.ts',
		'src/playwright/index.ts',
		'src/vite/index.ts',
		'src/dapp-kit/index.ts',
	],
	format: 'esm',
	dts: false,
	outDir: 'dist',
	unbundle: true,
	treeshake: true,
	platform: 'node',
	target: 'node22',
	sourcemap: true,
});

export default [main, fixtures];
