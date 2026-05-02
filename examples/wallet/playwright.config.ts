import { defineDevstackPlaywrightConfig } from '@mysten-incubation/devstack/playwright';

export default await defineDevstackPlaywrightConfig({
	port: 5174,
	manageStack: true,
	extend: {
		// Bump just the webServer timeout. defineDevstackPlaywrightConfig's
		// 300s default covers cold sui; this app imports deepbook so we
		// leave headroom but keep it tighter than private-content's needs.
		// `command` + `url` are shallow-merged from the default so the
		// allocator-resolved port survives the override.
		webServer: { timeout: 180_000 },
	},
});
