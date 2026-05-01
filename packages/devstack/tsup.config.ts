import { defineConfig } from 'tsup';

export default defineConfig({
	entry: {
		index: 'src/index.ts',
		'playwright/index': 'src/playwright/index.ts',
		'playwright/global-setup': 'src/playwright/global-setup.ts',
		'playwright/global-teardown': 'src/playwright/global-teardown.ts',
		vite: 'src/vite/plugin.ts',
		'vitest/index': 'src/vitest/index.ts',
		'vitest/runtime': 'src/vitest/runtime.ts',
		'cli/index': 'src/cli/index.ts',
		'cli/apply': 'src/cli/apply.ts',
		'cli/codegen': 'src/cli/codegen.ts',
		cli: 'src/cli.ts',
		helpers: 'src/helpers.ts',
		runtime: 'src/runtime.ts',
		'react/index': 'src/react/index.ts',
	},
	format: ['esm'],
	dts: true,
	clean: true,
	target: 'node22',
	sourcemap: true,
	splitting: false,
	shims: false,
	platform: 'node',
	// Optional peer deps that must stay external — they're declared in
	// `peerDependenciesMeta` as optional and only consumed via lazy
	// `import('....js')` from the React adapter. Bundling them would force
	// every devstack consumer to install them.
	external: [
		'@mysten/dapp-kit-core',
		'@mysten/dapp-kit-react',
		'@tanstack/react-query',
		'react',
		'react-dom',
	],
});
