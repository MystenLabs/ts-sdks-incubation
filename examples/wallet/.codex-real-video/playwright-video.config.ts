import { defineConfig, devices } from '@playwright/test';
import { baseURL, webServer } from '@mysten-incubation/devstack/playwright';

export default defineConfig({
	testDir: '../e2e',
	fullyParallel: false,
	workers: 1,
	reporter: 'list',
	webServer: webServer({ endpoint: 'dev-server', timeout: 300_000 }),
	use: {
		...devices['Desktop Chrome'],
		baseURL: baseURL({ endpoint: 'dev-server' }),
		viewport: { width: 1280, height: 720 },
		video: { mode: 'on', size: { width: 1280, height: 720 } },
		trace: 'off',
		screenshot: 'off',
	},
	projects: [{ name: 'chromium' }],
});
