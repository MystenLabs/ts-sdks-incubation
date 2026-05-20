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
	// Clear stale per-service dist dirs from the pre-`adf77bb` layout
	// (`dist/seal-image/`, `dist/sui-image/`, `dist/walrus-image/`) so a
	// publish never ships fossil image artifacts. Audit finding E68.
	clean: true,
	copy: [{ from: 'images/**/*', to: 'dist/images', flatten: false }],
});

// Test-fixture + vite-config subpaths. `dts: false` here because
// rolldown-plugin-dts chokes on @effect/vitest's transitive postcss
// types when bundling (also pulled in by the vite plugin's peers): it
// emits `Export 'AcceptedPlugin' is not defined` while parsing
// postcss's own d.mts. We sidestep the bundler by emitting these
// subpaths' dts with a separate `tsc --emitDeclarationOnly` step
// driven by `tsconfig.subpaths.json` (see the `build:dts-subpaths`
// script in package.json).
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

// Browser-safe subpath build. Targets the browser so any accidental
// `node:*` import surfaces as a build error here instead of a silent
// "Module externalized for browser compatibility" page-blank at runtime
// in apps that import via Vite. Keep the entry's downstream graph
// strictly pure (no engine/, no compose/, no manifest-emit, no docker
// shims) — see `src/browser/index.ts`'s header for what belongs here.
//
// `entry` uses a `{outName: srcPath}` form so the file lands at
// `dist/browser/index.mjs` regardless of where tsdown would otherwise
// stem-strip a single-entry path. `unbundle: false` is required —
// otherwise rolldown emits a chunk file referencing
// `services/walrus/options.mjs` which doesn't exist under the
// browser-build's tree, and the subpath import 404s at runtime.
const browser = defineConfig({
	entry: { 'browser/index': 'src/browser/index.ts' },
	format: 'esm',
	dts: true,
	outDir: 'dist',
	unbundle: false,
	treeshake: true,
	platform: 'browser',
	target: 'es2022',
	sourcemap: true,
	// Match the main/fixtures passes' `.mjs` extension so the package's
	// `./browser` export (which points at `./dist/browser/index.mjs`)
	// actually resolves. Without this rolldown defaults to `.js` and the
	// subpath 404s.
	outputOptions: { entryFileNames: '[name].mjs' },
});

export default [main, fixtures, browser];
