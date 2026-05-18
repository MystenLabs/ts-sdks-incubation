import { describe, expect, it } from 'vitest';
import { defineDevstackViteConfig } from './index.js';

describe('defineDevstackViteConfig', () => {
	it('emits the canonical plugin set + server defaults at minimum invocation', () => {
		const config = defineDevstackViteConfig();
		expect(Array.isArray(config.plugins)).toBe(true);
		expect((config.plugins ?? []).length).toBeGreaterThanOrEqual(2);
		expect(config.build).toMatchObject({ target: 'es2022' });
		expect(config.server?.allowedHosts).toEqual(['.localhost']);
		expect(config.server?.hmr).toMatchObject({ clientPort: 5175 });
		expect(config.server?.watch).toMatchObject({ ignored: ['**/.devstack/**'] });
	});

	it('honors the port option as $PORT fallback', () => {
		const prior = process.env.PORT;
		delete process.env.PORT;
		try {
			const config = defineDevstackViteConfig({ port: 5176 });
			expect(config.server?.port).toBe(5176);
		} finally {
			if (prior === undefined) delete process.env.PORT;
			else process.env.PORT = prior;
		}
	});

	it('lets the supervisor-assigned $PORT win over the configured fallback', () => {
		const prior = process.env.PORT;
		process.env.PORT = '5199';
		try {
			const config = defineDevstackViteConfig({ port: 5176 });
			expect(config.server?.port).toBe(5199);
		} finally {
			if (prior === undefined) delete process.env.PORT;
			else process.env.PORT = prior;
		}
	});

	it('aliases the hardcoded manifest path to the active stack', () => {
		const prior = process.env.DEVSTACK_STACK;
		process.env.DEVSTACK_STACK = 'test';
		try {
			const config = defineDevstackViteConfig({ appDir: '/tmp/myapp' });
			const aliases = config.resolve?.alias as Record<string, string>;
			expect(aliases['../../.devstack/manifest.json']).toMatch(
				/\/tmp\/myapp\/\.devstack\/stacks\/test\/manifest\.json$/,
			);
		} finally {
			if (prior === undefined) delete process.env.DEVSTACK_STACK;
			else process.env.DEVSTACK_STACK = prior;
		}
	});

	it('uses the flat manifest path on the main stack', () => {
		const prior = process.env.DEVSTACK_STACK;
		delete process.env.DEVSTACK_STACK;
		try {
			const config = defineDevstackViteConfig({ appDir: '/tmp/myapp' });
			const aliases = config.resolve?.alias as Record<string, string>;
			expect(aliases['../../.devstack/manifest.json']).toMatch(
				/\/tmp\/myapp\/\.devstack\/manifest\.json$/,
			);
		} finally {
			if (prior === undefined) delete process.env.DEVSTACK_STACK;
			else process.env.DEVSTACK_STACK = prior;
		}
	});

	it('appends extraPlugins after the bundled react+tailwind set', () => {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const marker = { name: 'test-extra' } as any;
		const config = defineDevstackViteConfig({ extraPlugins: [marker] });
		const plugins = config.plugins ?? [];
		expect(plugins[plugins.length - 1]).toBe(marker);
	});

	it('passes through unknown top-level keys via extend', () => {
		const config = defineDevstackViteConfig({ extend: { cacheDir: '/tmp/cache' } });
		expect(config.cacheDir).toBe('/tmp/cache');
	});
});
