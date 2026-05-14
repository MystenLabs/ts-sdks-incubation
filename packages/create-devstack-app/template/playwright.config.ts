import { defineConfig, devices } from '@playwright/test';
import { webServer } from '@mysten-incubation/devstack-effect/playwright';

// `pnpm dev` (the devstack supervisor) owns stack bring-up + writes
// the manifest. 300s timeout covers sui-localnet bring-up + publish +
// vite spawn.
export default defineConfig({
	testDir: './e2e',
	fullyParallel: false,
	workers: 1,
	forbidOnly: !!process.env.CI,
	retries: process.env.CI ? 2 : 0,
	reporter: process.env.CI ? [['github'], ['list']] : 'list',
	webServer: webServer({ endpoint: 'dev-server', timeout: 300_000 }),
	use: {
		trace: 'on-first-retry',
		screenshot: 'only-on-failure',
	},
	projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
