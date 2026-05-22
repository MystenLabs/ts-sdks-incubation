// Config helpers for the vitest integration.
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
//   - `test` keys win over preset defaults.

import { describe, expect, it } from 'vitest';

import {
	_internal,
	devstackVitestServerConfig,
	devstackVitestTestConfig,
} from '../../../src/build-integrations/vitest/config.ts';

describe('devstackVitestTestConfig', () => {
	it('produces canonical defaults', () => {
		const test = devstackVitestTestConfig();
		expect(test.passWithNoTests).toBe(true);
		expect(test.include).toEqual(['src/**/*.{test,spec}.ts?(x)', 'test/**/*.{test,spec}.ts?(x)']);
		expect(test.exclude).toContain('e2e/**');
		expect(test.exclude).toContain('node_modules');
		expect(test.exclude).toContain('dist');
		expect(test.exclude).toContain('**/.devstack/**');
	});

	it('does NOT wire setupFiles by default', () => {
		const test = devstackVitestTestConfig();
		expect(test.setupFiles).toBeUndefined();
	});

	it('testSetup: true wires the devstack setup module', () => {
		const test = devstackVitestTestConfig({ testSetup: true });
		expect(test.setupFiles).toEqual([_internal.DEVSTACK_SETUP_MODULE]);
	});

	it('testSetup with options also wires the setup module', () => {
		const test = devstackVitestTestConfig({ testSetup: { requireDevstack: true } });
		expect(test.setupFiles).toEqual([_internal.DEVSTACK_SETUP_MODULE]);
	});

	it('user setupFile appends AFTER the devstack setup file', () => {
		const test = devstackVitestTestConfig({
			testSetup: true,
			setupFile: '/abs/user-setup.ts',
		});
		expect(test.setupFiles).toEqual([_internal.DEVSTACK_SETUP_MODULE, '/abs/user-setup.ts']);
	});

	it('user setupFile alone (no testSetup) is wired solo', () => {
		const test = devstackVitestTestConfig({ setupFile: '/abs/user-setup.ts' });
		expect(test.setupFiles).toEqual(['/abs/user-setup.ts']);
	});

	it('typecheck defaults to off', () => {
		const test = devstackVitestTestConfig();
		expect(test.typecheck).toBeUndefined();
	});

	it('typecheck: true enables vitest typecheck', () => {
		const test = devstackVitestTestConfig({ typecheck: true });
		expect(test.typecheck?.enabled).toBe(true);
	});

	it('threads: "single" disables fileParallelism (vitest 4 shape)', () => {
		const test = devstackVitestTestConfig({ threads: 'single' });
		expect(test.pool).toBe('threads');
		expect(test.fileParallelism).toBe(false);
	});

	it('threads: "multi" enables fileParallelism', () => {
		const test = devstackVitestTestConfig({ threads: 'multi' });
		expect(test.pool).toBe('threads');
		expect(test.fileParallelism).toBe(true);
	});

	it('caller test fields override preset defaults (shallow merge)', () => {
		const test = devstackVitestTestConfig({
			test: { passWithNoTests: false, environment: 'jsdom' },
		});
		expect(test.passWithNoTests).toBe(false);
		expect(test.environment).toBe('jsdom');
		// Other defaults survive.
		expect(test.include).toBeDefined();
	});
});

describe('devstackVitestServerConfig', () => {
	it('watcher ignores .devstack/** (no-restart on harmless changes)', () => {
		const server = devstackVitestServerConfig();
		expect(server.watch?.ignored).toContain('**/.devstack/**');
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
