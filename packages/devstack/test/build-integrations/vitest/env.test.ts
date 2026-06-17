// Env-var contract for the vitest integration.
//
// Architecture invariants verified:
//   - DEVSTACK_STACK is the canonical signal for stack isolation; the
//     resolver reports whether it was explicit so the test-setup hook
//     can advise the user.
//   - DEVSTACK_RUNTIME_ROOT and the legacy DEVSTACK_STATE_DIR alias
//     resolve to the same field; new name wins when both set.
//   - Empty string is treated as unset (matches the engine's behavior
//     in discover-manifest.ts).

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
	DEFAULT_RUNTIME_ROOT,
	DEFAULT_STACK_NAME,
	RECOMMENDED_TEST_STACK,
	resolveVitestEnv,
	VITEST_ENV_VARS,
} from '../../../src/build-integrations/vitest/env.ts';
import { withTempRootSync } from '../../helpers/with-temp-root.ts';

describe('resolveVitestEnv', () => {
	it('defaults stack to "main" and runtimeRoot to ".devstack" when env is empty', () => {
		const r = resolveVitestEnv({});
		expect(r.stack).toBe(DEFAULT_STACK_NAME);
		expect(r.runtimeRoot).toBe(DEFAULT_RUNTIME_ROOT);
		expect(r.manifestPathOverride).toBeUndefined();
		expect(r.stackWasExplicit).toBe(false);
	});

	it('flags stackWasExplicit when DEVSTACK_STACK is set', () => {
		const r = resolveVitestEnv({ [VITEST_ENV_VARS.STACK]: RECOMMENDED_TEST_STACK });
		expect(r.stack).toBe('test');
		expect(r.stackWasExplicit).toBe(true);
	});

	it('treats empty-string DEVSTACK_STACK as unset', () => {
		const r = resolveVitestEnv({ [VITEST_ENV_VARS.STACK]: '' });
		expect(r.stack).toBe(DEFAULT_STACK_NAME);
		expect(r.stackWasExplicit).toBe(false);
	});

	it('honors DEVSTACK_RUNTIME_ROOT', () => {
		const r = resolveVitestEnv({ [VITEST_ENV_VARS.RUNTIME_ROOT]: '/abs/state' });
		expect(r.runtimeRoot).toBe('/abs/state');
	});

	it('falls back to the legacy DEVSTACK_STATE_DIR alias', () => {
		const r = resolveVitestEnv({
			[VITEST_ENV_VARS.RUNTIME_ROOT_LEGACY]: '/legacy/state',
		});
		expect(r.runtimeRoot).toBe('/legacy/state');
	});

	it('prefers DEVSTACK_RUNTIME_ROOT when both names are set', () => {
		const r = resolveVitestEnv({
			[VITEST_ENV_VARS.RUNTIME_ROOT]: '/new',
			[VITEST_ENV_VARS.RUNTIME_ROOT_LEGACY]: '/legacy',
		});
		expect(r.runtimeRoot).toBe('/new');
	});

	it('passes DEVSTACK_MANIFEST_PATH through as manifestPathOverride', () => {
		const r = resolveVitestEnv({
			[VITEST_ENV_VARS.MANIFEST_PATH]: '/m/manifest.json',
		});
		expect(r.manifestPathOverride).toBe('/m/manifest.json');
	});

	it('treats empty-string DEVSTACK_MANIFEST_PATH as unset', () => {
		const r = resolveVitestEnv({ [VITEST_ENV_VARS.MANIFEST_PATH]: '' });
		expect(r.manifestPathOverride).toBeUndefined();
	});

	// The opt-in `cwd` enables the package-name rung (mirroring
	// `resolveDiscoveryEnv` / the CLI's `resolveStackName`) so the setup
	// hook's advisory names the stack the loader will actually read.

	it('infers the stack from the nearest package.json when cwd is provided and env is unset', () =>
		withTempRootSync('devstack-vitest-env', (tmp) => {
			writeFileSync(join(tmp, 'package.json'), JSON.stringify({ name: '@scope/smoke-app' }));
			const r = resolveVitestEnv({}, { cwd: tmp });
			expect(r.stack).toBe('smoke-app');
			expect(r.stackWasExplicit).toBe(false);
		}));

	it('DEVSTACK_STACK wins over the package-name rung', () =>
		withTempRootSync('devstack-vitest-env', (tmp) => {
			writeFileSync(join(tmp, 'package.json'), JSON.stringify({ name: '@scope/smoke-app' }));
			const r = resolveVitestEnv({ [VITEST_ENV_VARS.STACK]: RECOMMENDED_TEST_STACK }, { cwd: tmp });
			expect(r.stack).toBe('test');
			expect(r.stackWasExplicit).toBe(true);
		}));

	it("falls back to 'main' when cwd has no reachable package.json", () =>
		withTempRootSync('devstack-vitest-env', (tmp) => {
			const r = resolveVitestEnv({}, { cwd: tmp });
			expect(r.stack).toBe(DEFAULT_STACK_NAME);
		}));
});
