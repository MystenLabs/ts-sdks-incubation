import { defineConfig } from 'tsdown';

// Main library + CLI bin. `dts: true` bundles types per-file.
// `copy:` mirrors plugin-owned static assets (Dockerfiles, entrypoints)
// from `images/<svc>/` into matching `dist/images/<svc>/` paths so
// primitives resolve them via `new URL('../../images/<svc>/', import.meta.url)`
// in both source and built outputs. `flatten: false` preserves the
// per-service subdir; the glob `images/**/*` matches every file under
// every service dir, including helper scripts like `entrypoint.sh` and
// `walrus/deploy.sh`.
// `src/runtime/conventional-routes.ts` is listed as an explicit entry —
// not because consumers import it directly from `dist`, but to anchor it
// inside the main build pass so its dependency on
// `listEndpointDeclarations` (from `src/engine/define-endpoint.ts`) is
// visible to tree-shaking. The fixtures build below also imports
// `conventional-routes` (via `playwright/web-server.ts`), but that pass
// externalizes engine modules — without this entry the main pass would
// drop `listEndpointDeclarations` and the fixtures build would emit a
// broken cross-config import.
//
// `src/runtime/read-stack-context.ts` is listed for the same reason:
// `playwright/web-server.ts` (fixtures pass) imports `readStackContextSync`
// from it, but the main pass's tree-shaker only sees the
// `readStackContext` (Effect) export consumed by CLI commands. Without
// this anchor entry the sync export gets dropped and the fixtures
// output emits a broken `import { readStackContextSync }` from the
// main pass's lean re-emit.
const main = defineConfig({
	entry: [
		'src/index.ts',
		'src/cli/main.ts',
		'src/advanced/index.ts',
		'src/runtime/conventional-routes.ts',
		'src/runtime/read-stack-context.ts',
	],
	format: 'esm',
	dts: true,
	outDir: 'dist',
	unbundle: true,
	treeshake: true,
	platform: 'node',
	target: 'node22',
	sourcemap: true,
	copy: [{ from: 'images/**/*', to: 'dist/images', flatten: false }],
});

// Test-fixture + vite-config subpaths. `dts: false` here because
// rolldown-plugin-dts chokes on @effect/vitest's transitive postcss
// types when bundling (and on @mysten/dapp-kit-react's postcss types
// transitively pulled in via the vite plugin's peers): it emits
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
	entry: ['src/vitest/index.ts', 'src/playwright/index.ts', 'src/vite/index.ts'],
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
