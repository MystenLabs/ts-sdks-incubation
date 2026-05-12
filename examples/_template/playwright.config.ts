import { defineDevstackPlaywrightConfig } from '@mysten-incubation/devstack/playwright';

// `manageStack: false` so the webServer's `pnpm dev` (which runs the
// devstack-next supervisor) owns stack bring-up — keeps a single
// supervisor in the loop instead of forking a separate apply pass
// against the legacy CLI which doesn't know how to load the new
// `devstack.config.ts` shape.
//
// `webServer.timeout` bumped to 300s — the default 60s isn't enough for
// `pnpm dev` to bring up sui-localnet (postgres sidecar + docker run +
// genesis bootstrap + indexer init takes 30-60s on a warm cache, more on
// cold), publish hello, run mint, emit manifest, and finally spawn vite.
export default await defineDevstackPlaywrightConfig({
	port: 5180,
	extend: { webServer: { timeout: 300_000 } },
});
