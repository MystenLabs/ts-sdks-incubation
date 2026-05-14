import { fileURLToPath } from 'node:url';

import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

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
		},
	},
	server: {
		port: 5174,
		strictPort: false,
		// Allow the Traefik router to proxy this dev-server in via the
		// stack-scoped hostname (`dev.<app>.localhost`).
		allowedHosts: ['.localhost'],
		// HMR client targets the public router port (5175); without
		// this Vite tells the browser to dial the upstream local
		// 5174, which the public hostname can't reach.
		hmr: { clientPort: 5175 },
	},
});
