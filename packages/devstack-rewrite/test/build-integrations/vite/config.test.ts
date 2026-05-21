// Unit tests for `defineDevstackViteConfig`.

import { describe, expect, it } from '@effect/vitest';

import { defineDevstackViteConfig } from '../../../src/build-integrations/vite/config.ts';
import { ViteConfigOptionsError } from '../../../src/build-integrations/vite/errors.ts';

describe('defineDevstackViteConfig', () => {
	it('emits ES2022 build target and pre-installs the devstack plugin', () => {
		const config = defineDevstackViteConfig({
			port: 5180,
			devstackPlugin: { app: 'demo', stack: 'main', stateDir: '/tmp/devstack-rewrite-test' },
		});
		expect(config.build).toMatchObject({ target: 'es2022' });
		const plugins = config.plugins ?? [];
		expect(plugins.length).toBeGreaterThanOrEqual(1);
		// The devstack plugin is at index 0.
		const first = plugins[0] as { readonly name?: string };
		expect(first.name).toBe('devstack:vite');
	});

	it('mirrors ES2022 to optimizeDeps.esbuildOptions', () => {
		const config = defineDevstackViteConfig({
			port: 5180,
			devstackPlugin: { app: 'demo', stack: 'main', stateDir: '/tmp/devstack-rewrite-test' },
		});
		expect(config.optimizeDeps?.esbuildOptions?.target).toBe('es2022');
	});

	it('honors port option when $PORT is unset', () => {
		const prior = process.env.PORT;
		delete process.env.PORT;
		try {
			const config = defineDevstackViteConfig({
				port: 5181,
				devstackPlugin: { app: 'demo', stack: 'main', stateDir: '/tmp/devstack-rewrite-test' },
			});
			expect(config.server?.port).toBe(5181);
		} finally {
			if (prior === undefined) delete process.env.PORT;
			else process.env.PORT = prior;
		}
	});

	it('lets supervisor-assigned $PORT win over the configured fallback', () => {
		const prior = process.env.PORT;
		process.env.PORT = '5199';
		try {
			const config = defineDevstackViteConfig({
				port: 5181,
				devstackPlugin: { app: 'demo', stack: 'main', stateDir: '/tmp/devstack-rewrite-test' },
			});
			expect(config.server?.port).toBe(5199);
		} finally {
			if (prior === undefined) delete process.env.PORT;
			else process.env.PORT = prior;
		}
	});

	it('rejects a non-positive port with ViteConfigOptionsError', () => {
		expect(() => defineDevstackViteConfig({ port: -1, devstackPlugin: { app: 'demo' } })).toThrow(
			ViteConfigOptionsError,
		);
		expect(() =>
			defineDevstackViteConfig({ port: 70_000, devstackPlugin: { app: 'demo' } }),
		).toThrow(ViteConfigOptionsError);
	});

	it('passes extra top-level keys via `extend`', () => {
		const config = defineDevstackViteConfig({
			port: 5180,
			devstackPlugin: { app: 'demo', stack: 'main', stateDir: '/tmp/devstack-rewrite-test' },
			extend: { cacheDir: '/tmp/cache' },
		});
		expect(config.cacheDir).toBe('/tmp/cache');
	});

	it('appends user plugins after the devstack plugin', () => {
		const marker = { name: 'test-extra' };
		const config = defineDevstackViteConfig({
			port: 5180,
			devstackPlugin: { app: 'demo', stack: 'main', stateDir: '/tmp/devstack-rewrite-test' },
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			plugins: [marker as any],
		});
		const plugins = config.plugins ?? [];
		const last = plugins[plugins.length - 1] as { readonly name?: string };
		expect(last.name).toBe('test-extra');
	});
});
