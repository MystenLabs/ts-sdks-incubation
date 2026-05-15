import { fileURLToPath } from 'node:url';

import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Resolve the per-stack manifest at vite start. `src/generated/manifest.ts`
// statically imports `../../.devstack/manifest.json`; alias it to the
// stack-scoped path so concurrent stacks of the same example each
// serve their OWN manifest (otherwise both vites would resolve the
// flat path, which the supervisor overwrites on every boot — last
// writer wins, every concurrent stack ends up with the wrong URLs).
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
			// Point `src/generated/manifest.ts`'s hardcoded
			// `../../.devstack/manifest.json` import at THIS stack's
			// manifest. Keyed by `DEVSTACK_STACK` env var the
			// supervisor sets on the vite child process.
			'../../.devstack/manifest.json': fileURLToPath(manifestUrl),
		},
	},
	server: {
		// Don't watch `.devstack/` — the supervisor writes the
		// per-stack manifest there during boot, and vite would broadcast
		// `full-reload` events to the browser. After the page reloads
		// it reconnects the HMR WS; vite replays the queued change and
		// the cycle repeats forever. The manifest is read at vite
		// startup; subsequent supervisor reboots need a manual browser
		// refresh, which is acceptable.
		watch: { ignored: ['**/.devstack/**'] },
		// Vite's UPSTREAM port. The devstack supervisor allocates a
		// per-stack host port (preferred 5170, may shift to 5171/5172
		// when sibling stacks claim the lower number) and exposes it
		// as `$PORT`. Read it here so vite binds the port the router
		// already forwards to. Fallback to 5170 for `vite` invoked
		// outside the supervisor (e.g. `pnpm exec vite` in editor).
		port: Number(process.env.PORT) || 5170,
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
