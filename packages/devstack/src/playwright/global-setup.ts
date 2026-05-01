// Playwright globalSetup — brings the localnet stack up before any
// test file runs. Reads the config path + stack name from env vars set
// by `defineDevstackPlaywrightConfig`. Exits non-zero if bring-up fails;
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
