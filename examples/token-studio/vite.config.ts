import { fileURLToPath } from 'node:url';

import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Per-stack manifest resolution — see private-content/vite.config.ts.
const stack = process.env.DEVSTACK_STACK ?? 'main';
const manifestUrl =
	stack === 'main'
		? new URL('./.devstack/manifest.json', import.meta.url)
		: new URL(`./.devstack/stacks/${stack}/manifest.json`, import.meta.url);

export default defineConfig({
	plugins: [react(), tailwindcss()],
	// `createDevstackDappKit` from `@mysten-incubation/devstack/dapp-kit` is
	// async (lazy-loads the panels module so `mountUI: false` bundles
	// drop ~30KB of devstack panels). Apps `await` it at module top
	// level in `dapp-kit.ts`, which requires top-level await — bump the
	// build target accordingly. `optimizeDeps` mirrors the build target
	// so Vite's dev-mode pre-bundle (esbuild, defaults to es2020) also
	// accepts top-level await in dependency code.
	build: { target: 'es2022' },
	optimizeDeps: {
		esbuildOptions: { target: 'es2022' },
	},
	resolve: {
		alias: {
			'@': fileURLToPath(new URL('./src', import.meta.url)),
			'../../.devstack/manifest.json': fileURLToPath(manifestUrl),
		},
	},
	server: {
		// Skip `.devstack/` so vite doesn't loop full-reload on the
		// per-stack manifest the supervisor writes there (see
		// private-content/vite.config.ts for the long-form rationale).
		watch: { ignored: ['**/.devstack/**'] },
		// Per-stack port comes in via `$PORT` from the devstack supervisor's
		// allocator. Fallback 5173 for `vite` invoked outside the supervisor.
		port: Number(process.env.PORT) || 5173,
		strictPort: false,
		// Allow the Traefik router to proxy this dev-server in via the
		// stack-scoped hostname (`dev.<app>.localhost`).
		allowedHosts: ['.localhost'],
		// HMR client targets the public router port (5175); without
		// this Vite tells the browser to dial the upstream local
		// port, which the public hostname can't reach.
		hmr: { clientPort: 5175 },
	},
});
