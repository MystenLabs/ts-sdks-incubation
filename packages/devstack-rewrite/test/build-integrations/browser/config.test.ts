import { describe, expect, it } from 'vitest';

import { defineDevstackBrowserConfig } from '../../../src/build-integrations/browser/config.ts';

describe('defineDevstackBrowserConfig', () => {
	it('uses the flat browser setup export subpath', () => {
		const cfg = defineDevstackBrowserConfig();
		expect(cfg.test?.setupFiles).toEqual(['@mysten-incubation/devstack/browser/setup']);
	});

	it('appends user setup files after the devstack browser setup file', () => {
		const cfg = defineDevstackBrowserConfig({ extraSetupFiles: ['/abs/browser-setup.ts'] });
		expect(cfg.test?.setupFiles).toEqual([
			'@mysten-incubation/devstack/browser/setup',
			'/abs/browser-setup.ts',
		]);
	});
});
