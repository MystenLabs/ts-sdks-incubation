// Playwright globalSetup — brings the localnet stack up before any
// test file runs. Uses `runUp({ once: true })` (Supervisor in
// one-shot mode) which fires shutdown hooks at the end. The hooks:
//
//   - sui.localnet stops the docker container (volume preserved →
//     resumable). The next supervisor cycle (webServer's `pnpm dev`)
//     restarts it via the resume path in seconds.
//   - wallet-server closes its in-process http.Server so the port
//     releases for the webServer's child process to claim. The
//     persisted token on disk lets the new server emit a new pair URL
//     without losing test continuity.
//   - vite kills its child process. The webServer's `pnpm dev` spawns
//     a new vite the same way.
//
// `runApply` (one-shot, no shutdown hooks) was tried earlier — it
// avoided the sui-container restart but leaked the wallet-server
// http.Server across processes, causing EADDRINUSE in the webServer
// child for stacks where the cold-cache walrus/seal build pushed the
// startup race past the point of harmless overlap (private-content).
//
// Reads config path + stack name from env vars set by
// `defineDevstackPlaywrightConfig`. Exits non-zero if bring-up fails;
// playwright surfaces that as a setup error.

import { runUp } from '../cli/up.js';

export default async function globalSetup(): Promise<void> {
	const configPath = process.env.DEVSTACK_E2E_CONFIG_PATH;
	if (configPath === undefined || configPath.length === 0) {
		throw new Error(
			'devstack/playwright globalSetup: DEVSTACK_E2E_CONFIG_PATH is not set. ' +
				'Use `defineDevstackPlaywrightConfig({ setup: { configPath: ... } })`.',
		);
	}
	const stack = process.env.DEVSTACK_STACK ?? 'test';
	const code = await runUp({
		configPath,
		stack,
		network: 'localnet',
		once: true,
	});
	if (code !== 0) {
		throw new Error(`devstack/playwright globalSetup: bring-up exited ${code}`);
	}
}
