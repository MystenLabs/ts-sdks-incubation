export { connectAs, selectAccount, waitForBalanceUpdate } from './helpers.js';
export { setupDevstack, type DevstackPlaywrightFixture } from './setup-devstack.js';
export { baseURL, webServer, type BaseURLOptions, type WebServerOptions } from './web-server.js';
export {
	defineDevstackPlaywrightConfig,
	type DevstackPlaywrightConfigOptions,
} from './define-config.js';

// Re-export Playwright's `test`/`expect` so callers can import everything
// from a single module — matches v3's surface and lets specs use
// `import { test, expect, connectAs } from '@mysten-incubation/devstack/playwright'`.
export { expect, test } from '@playwright/test';
