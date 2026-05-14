import { defineConfig, devices } from '@playwright/test';
import { baseURL, webServer } from '@mysten-incubation/devstack-effect/playwright';

// `pnpm dev` (the devstack supervisor) owns stack bring-up + writes
// the manifest. 15-minute timeout because the first run has to build
// walrus (~10 min cargo) and seal (~5-8 min) images cold; warm runs
// are seconds.
export default defineConfig({
	testDir: './e2e',
	fullyParallel: false,
	workers: 1,
	forbidOnly: !!process.env.CI,
	retries: process.env.CI ? 2 : 0,
	reporter: process.env.CI ? [['github'], ['list']] : 'list',
	webServer: webServer({ endpoint: 'dev-server', timeout: 900_000 }),
	use: {
		baseURL: baseURL({ endpoint: 'dev-server' }),
		trace: 'on-first-retry',
		screenshot: 'only-on-failure',
	},
	projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
