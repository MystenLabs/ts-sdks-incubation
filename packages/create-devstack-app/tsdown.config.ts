import { defineConfig } from 'tsdown';

export default defineConfig({
	entry: ['src/index.ts', 'src/bin.ts'],
	format: 'esm',
	dts: true,
	outDir: 'dist',
	unbundle: true,
	treeshake: false,
	platform: 'node',
	target: 'node22',
	// Bundle `@clack/prompts` (and its transitive deps) INTO dist so
	// `pnpm create @mysten-incubation/devstack-app` works the moment the
	// package is fetched: the picker must run BEFORE the scaffolded app's own
	// `pnpm install`, so the prompt dep cannot be a separately-resolved
	// runtime dependency. tsdown inlines listed deps even in unbundle mode.
	// Everything else stays external (node builtins; workspace SDKs are
	// injected into the scaffolded app, never imported by the bin itself).
	noExternal: ['@clack/prompts'],
});
