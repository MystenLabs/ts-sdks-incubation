import { defineConfig } from 'tsdown';

// Main library + CLI bin. `dts: true` bundles types per-file.
// `copy:` mirrors plugin-owned static assets (Dockerfiles, entrypoints)
// into matching `dist/` paths so primitives resolve them via
// `new URL('../../<asset>/', import.meta.url)` in both source and built
// outputs.
const main = defineConfig({
	entry: ['src/index.ts', 'src/cli/main.ts', 'src/plugin-author/index.ts'],
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
// package.json). See `notes/friction.md` for the re-investigation plan
// once rolldown-plugin-dts upstream fixes the bug.
const fixtures = defineConfig({
	entry: ['src/vitest/index.ts', 'src/playwright/index.ts', 'src/dapp-kit/index.ts'],
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
