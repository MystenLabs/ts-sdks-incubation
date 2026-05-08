// Playwright globalTeardown — stops the localnet stack's containers
// after every test file has finished. Volumes are preserved so the
// next `pnpm dev`/`pnpm test:e2e` resumes without a full re-publish.
//
// `defineDevstackPlaywrightConfig({ teardown: 'drop' })` wipes volumes
// too (CI mode); the helper translates the typed opt into the
// `DEVSTACK_E2E_TEARDOWN` env var that this module reads.

import { runStack } from '../cli/stack.js';

export default async function globalTeardown(): Promise<void> {
	const configPath = process.env.DEVSTACK_E2E_CONFIG_PATH;
	if (configPath === undefined || configPath.length === 0) return;
	const stack = process.env.DEVSTACK_STACK ?? 'test';
	const mode = process.env.DEVSTACK_E2E_TEARDOWN ?? 'down';
	if (mode === 'none') return;
	const subcommand = mode === 'drop' ? 'drop' : 'down';
	await runStack({
		configPath,
		subcommand,
		stackName: stack,
		yes: true,
		force: subcommand === 'drop',
	});
}
