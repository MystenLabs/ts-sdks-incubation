import { defineConfig } from 'tsdown';

// Runtime library + CLI bin. The CLI and user config must load the
// same module graph so Context.Service tags and plugin tags have a
// single identity. Keep this build unbundled: the bin imports the same
// dist modules that package consumers import through `exports`.
export default defineConfig({
	entry: [
		'src/index.ts',
		'src/contracts/index.ts',
		'src/substrate/index.ts',
		'src/build-integrations/vite/index.ts',
		'src/build-integrations/vitest/index.ts',
		'src/build-integrations/vitest/setup.ts',
		'src/build-integrations/playwright/index.ts',
		'src/build-integrations/browser/index.ts',
		'src/build-integrations/browser/setup.ts',
		'src/build-integrations/runtime/index.ts',
		'src/cli/main.ts',
	],
	format: 'esm',
	dts: true,
	outDir: 'dist',
	unbundle: true,
	treeshake: true,
	platform: 'node',
	target: 'node22',
	sourcemap: true,
	clean: true,
	// Shebang so `chmod +x dist/cli/main.mjs && ./dist/cli/main.mjs status`
	// works without `node` prefix once the package is installed globally.
	outputOptions: {
		banner: (chunk) => (chunk.fileName === 'cli/main.mjs' ? '#!/usr/bin/env node' : ''),
		entryFileNames: '[name].mjs',
	},
});
