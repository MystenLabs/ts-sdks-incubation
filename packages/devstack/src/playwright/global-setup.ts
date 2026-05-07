// Playwright globalSetup — brings the localnet stack to a known state
// before any test file runs. Runs `runOneShot` with `applyTestSetupFilter`:
//
//   - All Build/Publish/Register/Seed/Emit/Verify actions run, leaving the
//     chain seeded (packages published, accounts funded, walrus deployed).
//   - All Service actions run — docker containers start and detach,
//     surviving this process's exit.
//   - HostProcess actions (wallet-server's in-process Node http.Server,
//     vite dev-server) DO NOT run here. They die with their parent
//     process and would leave a window between globalSetup exit and
//     webServer spawn where a Playwright page could load a dead-token
//     manifest. The webServer's `pnpm dev` Supervisor owns HostProcess
//     lifecycle from then on, as the sole authority — eliminating the
//     two-supervisor token race documented in
//     notes/architecture-review/23-playwright-integration.md.
//
// No supervisor wrapper, no shutdown hooks, no signal handlers. One walk,
// exit. Reads config path + stack name from env vars set by
// `defineDevstackPlaywrightConfig`. Exits non-zero if bring-up fails.

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { loadConfig } from '../cli/args.js';
import { applyTestSetupFilter } from '../cli/filters.js';
import { stackDir } from '../runtime/active-stack.js';
import { runOneShot } from '../runtime/one-shot.js';

export default async function globalSetup(): Promise<void> {
	const configPath = process.env.DEVSTACK_E2E_CONFIG_PATH;
	if (configPath === undefined || configPath.length === 0) {
		throw new Error(
			'devstack/playwright globalSetup: DEVSTACK_E2E_CONFIG_PATH is not set. ' +
				'Use `defineDevstackPlaywrightConfig({ manageStack: true, configPath: ... })`.',
		);
	}
	const abs = resolve(configPath);
	const config = await loadConfig(abs);
	const appDir = dirname(abs);
	const stack = process.env.DEVSTACK_STACK ?? 'test';

	const result = await runOneShot({
		appName: config.app,
		appDir,
		network: 'localnet',
		rpcUrl: config.networks?.localnet ?? '',
		plugins: config.plugins,
		accounts: config.accounts,
		stack,
		actionFilter: applyTestSetupFilter,
	});

	if (result.failures.size > 0) {
		const summary = [...result.failures.entries()]
			.map(([name, err]) => `  ${name}: ${err.message}`)
			.join('\n');
		throw new Error(
			`devstack/playwright globalSetup: ${result.failures.size} action(s) failed:\n${summary}`,
		);
	}

	// Drop a fresh-apply marker so the webServer's `pnpm dev` Supervisor
	// (spawned moments later) skips the redundant non-HostProcess
	// reconcile on its first cycle. Saves ~5s of getStatus probes per
	// warm e2e run; supervisor consumes (deletes) the marker after
	// reading it so only the immediate-next start benefits.
	const markerDir = stackDir(appDir, stack);
	mkdirSync(markerDir, { recursive: true });
	writeFileSync(resolve(markerDir, '.last-apply-at'), `${Date.now()}\n`, 'utf8');
}
