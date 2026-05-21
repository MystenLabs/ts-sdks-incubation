// Config builder for the vitest integration.
//
// Architecture invariants verified:
//   - Default include covers `src/**` + `test/**`; e2e/dist/node_modules
//     excluded.
//   - `passWithNoTests: true` (codegen-derived stacks without unit
//     tests yet shouldn't fail CI).
//   - Watcher ignores `.devstack/**` — no-restart on harmless manifest
//     ticks.
//   - `testSetup` toggles the devstack setupFile injection.
//   - `setupFile` user-authored override appends AFTER the devstack
//     setupFile (so user setup sees the captured StackContext).
//   - `typecheck: true` opts in; default is off.
//   - `threads: 'single' | 'multi'` flips top-level `fileParallelism`
//     (vitest 4 shape — replaces v3's `poolOptions.threads.singleThread`).
//   - `extend` top-level keys win; `test` keys win over preset defaults.

import { describe, expect, it } from 'vitest';

import {
	_internal,
	defineDevstackVitestConfig,
} from '../../../src/build-integrations/vitest/config.ts';

describe('defineDevstackVitestConfig', () => {
	it('produces canonical defaults', () => {
		const cfg = defineDevstackVitestConfig();
		expect(cfg.test?.passWithNoTests).toBe(true);
		expect(cfg.test?.include).toEqual([
			'src/**/*.{test,spec}.ts?(x)',
			'test/**/*.{test,spec}.ts?(x)',
		]);
		expect(cfg.test?.exclude).toContain('e2e/**');
		expect(cfg.test?.exclude).toContain('node_modules');
		expect(cfg.test?.exclude).toContain('dist');
		expect(cfg.test?.exclude).toContain('**/.devstack/**');
	});

	it('does NOT wire setupFiles by default', () => {
		const cfg = defineDevstackVitestConfig();
		expect(cfg.test?.setupFiles).toBeUndefined();
	});

	it('testSetup: true wires the devstack setup module', () => {
		const cfg = defineDevstackVitestConfig({ testSetup: true });
		expect(cfg.test?.setupFiles).toEqual([_internal.DEVSTACK_SETUP_MODULE]);
	});

	it('testSetup with options also wires the setup module', () => {
		const cfg = defineDevstackVitestConfig({ testSetup: { requireDevstack: true } });
		expect(cfg.test?.setupFiles).toEqual([_internal.DEVSTACK_SETUP_MODULE]);
	});

	it('user setupFile appends AFTER the devstack setup file', () => {
		const cfg = defineDevstackVitestConfig({
			testSetup: true,
			setupFile: '/abs/user-setup.ts',
		});
		expect(cfg.test?.setupFiles).toEqual([_internal.DEVSTACK_SETUP_MODULE, '/abs/user-setup.ts']);
	});

	it('user setupFile alone (no testSetup) is wired solo', () => {
		const cfg = defineDevstackVitestConfig({ setupFile: '/abs/user-setup.ts' });
		expect(cfg.test?.setupFiles).toEqual(['/abs/user-setup.ts']);
	});

	it('typecheck defaults to off', () => {
		const cfg = defineDevstackVitestConfig();
		expect(cfg.test?.typecheck).toBeUndefined();
	});

	it('typecheck: true enables vitest typecheck', () => {
		const cfg = defineDevstackVitestConfig({ typecheck: true });
		expect(cfg.test?.typecheck?.enabled).toBe(true);
	});

	it('threads: "single" disables fileParallelism (vitest 4 shape)', () => {
		const cfg = defineDevstackVitestConfig({ threads: 'single' });
		expect(cfg.test?.pool).toBe('threads');
		expect(cfg.test?.fileParallelism).toBe(false);
	});

	it('threads: "multi" enables fileParallelism', () => {
		const cfg = defineDevstackVitestConfig({ threads: 'multi' });
		expect(cfg.test?.pool).toBe('threads');
		expect(cfg.test?.fileParallelism).toBe(true);
	});

	it('caller test fields override preset defaults (shallow merge)', () => {
		const cfg = defineDevstackVitestConfig({
			test: { passWithNoTests: false, environment: 'jsdom' },
		});
		expect(cfg.test?.passWithNoTests).toBe(false);
		expect(cfg.test?.environment).toBe('jsdom');
		// Other defaults survive.
		expect(cfg.test?.include).toBeDefined();
	});

	it('watcher ignores .devstack/** (no-restart on harmless changes)', () => {
		const cfg = defineDevstackVitestConfig();
		expect(cfg.server?.watch?.ignored).toContain('**/.devstack/**');
	});

	it('extend top-level keys override preset top-level keys', () => {
		const cfg = defineDevstackVitestConfig({
			extend: { server: { host: '0.0.0.0' } as never },
		});
		// Extend's `server` wins entirely (per documented contract).
		expect((cfg.server as { host?: string }).host).toBe('0.0.0.0');
	});
});

describe('_internal', () => {
	it('exposes the devstack setup module specifier as a constant', () => {
		expect(_internal.DEVSTACK_SETUP_MODULE).toMatch(
			/^@mysten-incubation\/devstack\/vitest\/setup$/,
		);
	});

	it('watch-ignored patterns include .devstack/**', () => {
		expect(_internal.WATCH_IGNORED_PATTERNS).toContain('**/.devstack/**');
	});
});
