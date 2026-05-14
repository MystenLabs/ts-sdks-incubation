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
		// Vite's UPSTREAM port. Distinct from traefik's `vite` entrypoint
		// (5175 host); the supervisor's devstack.config flag mirrors this.
		port: 5170,
		strictPort: false,
		// Allow the Traefik router to proxy this dev-server in via the
		// stack-scoped hostname (`dev.<app>.localhost`). Without this
		// Vite's `Host:` header allowlist rejects requests routed
		// through traefik.
		allowedHosts: ['.localhost'],
		// HMR over the router: the client (in the browser) talks WS to
		// the PUBLIC router port (5175); the router forwards to vite on
		// 5170. Pin clientPort=5175 so the HMR client dials the public
		// router port from the browser, not vite's upstream 5170.
		hmr: { clientPort: 5175 },
	},
});
