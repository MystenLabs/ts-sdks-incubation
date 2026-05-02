// Playwright globalSetup — brings the localnet stack up before any
// test file runs. Uses `runApply` (one-shot reconcile, no supervisor)
// rather than `devstack up --once` so the cycle DOESN'T fire shutdown
// hooks at the end. Then `pnpm dev` (running `devstack up` in
// keepalive mode) takes ownership of the stack while tests execute.
//
// The wallet-server token is persisted to disk (see
// `plugins/wallet-server`), so the second supervisor incarnation
// adopts the still-running server without re-binding the port and
// without losing the bearer token already published to the manifest.
//
// Reads config path + stack name from env vars set by
// `defineDevstackPlaywrightConfig`. Exits non-zero if bring-up fails;
// playwright surfaces that as a setup error.

import { runApply } from '../cli/apply.js';

export default async function globalSetup(): Promise<void> {
	const configPath = process.env.DEVSTACK_E2E_CONFIG_PATH;
	if (configPath === undefined || configPath.length === 0) {
		throw new Error(
			'devstack/playwright globalSetup: DEVSTACK_E2E_CONFIG_PATH is not set. ' +
				'Use `defineDevstackPlaywrightConfig({ setup: { configPath: ... } })`.',
		);
	}
	const stack = process.env.DEVSTACK_STACK ?? 'test';
	// `runApply` resolves the target via `--target` flag or active stack;
	// we pass the stack via env var so the resolveTarget path picks it up.
	const prevStack = process.env.DEVSTACK_STACK;
	process.env.DEVSTACK_STACK = stack;
	try {
		const code = await runApply({ configPath });
		if (code !== 0) {
			throw new Error(`devstack/playwright globalSetup: apply exited ${code}`);
		}
	} finally {
		if (prevStack === undefined) delete process.env.DEVSTACK_STACK;
		else process.env.DEVSTACK_STACK = prevStack;
	}
}
