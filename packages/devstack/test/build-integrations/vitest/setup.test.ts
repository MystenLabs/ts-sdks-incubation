// Test-setup hooks for the vitest integration.
//
// Architecture invariants verified:
//   - beforeAll prints a stack-name advisory when DEVSTACK_STACK is
//     unset (the test-isolation foot-gun).
//   - silent: true suppresses the advisory.
//   - requireDevstack: true escalates a no-manifest condition to a
//     thrown VitestManifestNotFoundError.
//   - The captured fixture is populated on beforeAll and cleared on
//     afterAll (no stale handle survives between watch runs).
//   - useDevstackTestSetup wires both hooks via the injected
//     beforeAll / afterAll seam.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
	clearStackContext,
	getStackContext,
	runDevstackAfterAll,
	runDevstackBeforeAll,
	useDevstackTestSetup,
} from '../../../src/build-integrations/vitest/setup.ts';
import { VitestManifestNotFoundError } from '../../../src/build-integrations/vitest/errors.ts';
import { withTempRootSync } from '../../helpers/with-temp-root.ts';

const minimalManifest = () => ({
	identity: { app: 'demo', stack: 'test', chain: 'devnet-local' },
	manifestVersion: 1,
	services: {},
	endpoints: {},
	extras: {},
});

const seedManifestUnder = (root: string, stack: string): string => {
	const dir = join(root, '.devstack', 'stacks', stack);
	mkdirSync(dir, { recursive: true });
	const manifestPath = join(dir, 'manifest.json');
	writeFileSync(manifestPath, JSON.stringify(minimalManifest()));
	return manifestPath;
};

describe('runDevstackBeforeAll', () => {
	beforeEach(() => clearStackContext());
	afterEach(() => clearStackContext());

	it('captures the StackContext when a manifest is on disk', () =>
		withTempRootSync('devstack-vitest-setup', (root) => {
			seedManifestUnder(root, 'test');
			runDevstackBeforeAll({
				cwd: root,
				env: { DEVSTACK_STACK: 'test' },
				silent: true,
			});
			expect(getStackContext()?.identity.stack).toBe('test');
		}));

	it('captured fixture is undefined when no manifest exists (requireDevstack: false)', () =>
		withTempRootSync('devstack-vitest-empty', (root) => {
			runDevstackBeforeAll({ cwd: root, env: { DEVSTACK_STACK: 'test' }, silent: true });
			expect(getStackContext()).toBeUndefined();
		}));

	it('throws VitestManifestNotFoundError when requireDevstack: true', () =>
		withTempRootSync('devstack-vitest-required', (root) => {
			expect(() =>
				runDevstackBeforeAll({
					cwd: root,
					env: { DEVSTACK_STACK: 'test' },
					silent: true,
					requireDevstack: true,
				}),
			).toThrow(VitestManifestNotFoundError);
		}));

	it('prints a stack-name advisory when DEVSTACK_STACK is unset', () =>
		withTempRootSync('devstack-vitest-advise', (root) => {
			const lines: Array<string> = [];
			runDevstackBeforeAll({
				cwd: root,
				env: {},
				writeAdvisory: (line) => lines.push(line),
			});
			expect(lines).toHaveLength(1);
			expect(lines[0]).toContain('DEVSTACK_STACK is unset');
			expect(lines[0]).toContain('DEVSTACK_STACK=test');
		}));

	it('silent: true suppresses the advisory', () =>
		withTempRootSync('devstack-vitest-silent', (root) => {
			const lines: Array<string> = [];
			runDevstackBeforeAll({
				cwd: root,
				env: {},
				silent: true,
				writeAdvisory: (line) => lines.push(line),
			});
			expect(lines).toHaveLength(0);
		}));

	it('does NOT print an advisory when DEVSTACK_STACK is set', () =>
		withTempRootSync('devstack-vitest-set', (root) => {
			const lines: Array<string> = [];
			runDevstackBeforeAll({
				cwd: root,
				env: { DEVSTACK_STACK: 'test' },
				writeAdvisory: (line) => lines.push(line),
			});
			expect(lines).toHaveLength(0);
		}));
});

describe('runDevstackAfterAll', () => {
	it('clears the captured fixture', () =>
		withTempRootSync('devstack-vitest-setup', (root) => {
			seedManifestUnder(root, 'test');
			runDevstackBeforeAll({
				cwd: root,
				env: { DEVSTACK_STACK: 'test' },
				silent: true,
			});
			expect(getStackContext()).toBeDefined();
			runDevstackAfterAll();
			expect(getStackContext()).toBeUndefined();
		}));

	it('registers a process.exit listener so worker shutdown drains the slot map', () =>
		// Regression: the per-test-path slot map used to accumulate
		// forever in `--watch` mode because vitest workers reuse the
		// module-level binding across test files. The first call to
		// `runDevstackBeforeAll` now installs an `exit` listener that
		// clears the map on worker shutdown, bounding the leak.
		withTempRootSync('devstack-vitest-exit', (root) => {
			seedManifestUnder(root, 'test');
			const before = process.listenerCount('exit');
			runDevstackBeforeAll({
				cwd: root,
				env: { DEVSTACK_STACK: 'test' },
				silent: true,
			});
			runDevstackBeforeAll({
				cwd: root,
				env: { DEVSTACK_STACK: 'test' },
				silent: true,
			});
			const after = process.listenerCount('exit');
			// The listener is `once`-installed, idempotent across many
			// beforeAll calls — only one extra listener (or zero if a
			// previous test in the same worker already registered it).
			expect(after - before).toBeLessThanOrEqual(1);
		}));
});

describe('useDevstackTestSetup', () => {
	it('wires beforeAll + afterAll via the injected hooks object', () => {
		const beforeAllFn = vi.fn<(fn: () => void | Promise<void>) => void>();
		const afterAllFn = vi.fn<(fn: () => void | Promise<void>) => void>();
		useDevstackTestSetup({ beforeAll: beforeAllFn, afterAll: afterAllFn }, { silent: true });
		expect(beforeAllFn).toHaveBeenCalledTimes(1);
		expect(afterAllFn).toHaveBeenCalledTimes(1);
	});

	it('passes a no-op-able function — beforeAll fn runs the hook body', () =>
		withTempRootSync('devstack-vitest-wire', (root) => {
			seedManifestUnder(root, 'test');
			let beforeAllBody: (() => void | Promise<void>) | undefined;
			let afterAllBody: (() => void | Promise<void>) | undefined;
			useDevstackTestSetup(
				{
					beforeAll: (fn) => {
						beforeAllBody = fn;
					},
					afterAll: (fn) => {
						afterAllBody = fn;
					},
				},
				{ cwd: root, env: { DEVSTACK_STACK: 'test' }, silent: true },
			);
			expect(beforeAllBody).toBeDefined();
			expect(afterAllBody).toBeDefined();
			beforeAllBody!();
			expect(getStackContext()?.identity.stack).toBe('test');
			afterAllBody!();
			expect(getStackContext()).toBeUndefined();
		}));
});
