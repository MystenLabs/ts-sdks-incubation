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

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
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

const minimalManifest = () => ({
	identity: { app: 'demo', stack: 'test', chain: 'devnet-local' },
	manifestVersion: 1,
	services: {},
	endpoints: {},
	extras: {},
});

const withTmpManifest = (
	stack: string,
): { root: string; manifestPath: string; cleanup: () => void } => {
	const root = mkdtempSync(join(tmpdir(), 'devstack-vitest-setup-'));
	const dir = join(root, '.devstack', 'stacks', stack);
	mkdirSync(dir, { recursive: true });
	const manifestPath = join(dir, 'manifest.json');
	writeFileSync(manifestPath, JSON.stringify(minimalManifest()));
	return { root, manifestPath, cleanup: () => rmSync(root, { recursive: true, force: true }) };
};

describe('runDevstackBeforeAll', () => {
	beforeEach(() => clearStackContext());
	afterEach(() => clearStackContext());

	it('captures the StackContext when a manifest is on disk', () => {
		const { root, cleanup } = withTmpManifest('test');
		try {
			runDevstackBeforeAll({
				cwd: root,
				env: { DEVSTACK_STACK: 'test' },
				silent: true,
			});
			expect(getStackContext()?.identity.stack).toBe('test');
		} finally {
			cleanup();
		}
	});

	it('captured fixture is undefined when no manifest exists (requireDevstack: false)', () => {
		const root = mkdtempSync(join(tmpdir(), 'devstack-vitest-empty-'));
		try {
			runDevstackBeforeAll({ cwd: root, env: { DEVSTACK_STACK: 'test' }, silent: true });
			expect(getStackContext()).toBeUndefined();
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it('throws VitestManifestNotFoundError when requireDevstack: true', () => {
		const root = mkdtempSync(join(tmpdir(), 'devstack-vitest-required-'));
		try {
			expect(() =>
				runDevstackBeforeAll({
					cwd: root,
					env: { DEVSTACK_STACK: 'test' },
					silent: true,
					requireDevstack: true,
				}),
			).toThrow(VitestManifestNotFoundError);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it('prints a stack-name advisory when DEVSTACK_STACK is unset', () => {
		const root = mkdtempSync(join(tmpdir(), 'devstack-vitest-advise-'));
		try {
			const lines: Array<string> = [];
			runDevstackBeforeAll({
				cwd: root,
				env: {},
				writeAdvisory: (line) => lines.push(line),
			});
			expect(lines).toHaveLength(1);
			expect(lines[0]).toContain('DEVSTACK_STACK is unset');
			expect(lines[0]).toContain('DEVSTACK_STACK=test');
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it('silent: true suppresses the advisory', () => {
		const root = mkdtempSync(join(tmpdir(), 'devstack-vitest-silent-'));
		try {
			const lines: Array<string> = [];
			runDevstackBeforeAll({
				cwd: root,
				env: {},
				silent: true,
				writeAdvisory: (line) => lines.push(line),
			});
			expect(lines).toHaveLength(0);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it('does NOT print an advisory when DEVSTACK_STACK is set', () => {
		const root = mkdtempSync(join(tmpdir(), 'devstack-vitest-set-'));
		try {
			const lines: Array<string> = [];
			runDevstackBeforeAll({
				cwd: root,
				env: { DEVSTACK_STACK: 'test' },
				writeAdvisory: (line) => lines.push(line),
			});
			expect(lines).toHaveLength(0);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

describe('runDevstackAfterAll', () => {
	it('clears the captured fixture', () => {
		const { root, cleanup } = withTmpManifest('test');
		try {
			runDevstackBeforeAll({
				cwd: root,
				env: { DEVSTACK_STACK: 'test' },
				silent: true,
			});
			expect(getStackContext()).toBeDefined();
			runDevstackAfterAll();
			expect(getStackContext()).toBeUndefined();
		} finally {
			cleanup();
		}
	});
});

describe('useDevstackTestSetup', () => {
	it('wires beforeAll + afterAll via the injected hooks object', () => {
		const beforeAllFn = vi.fn<(fn: () => void | Promise<void>) => void>();
		const afterAllFn = vi.fn<(fn: () => void | Promise<void>) => void>();
		useDevstackTestSetup({ beforeAll: beforeAllFn, afterAll: afterAllFn }, { silent: true });
		expect(beforeAllFn).toHaveBeenCalledTimes(1);
		expect(afterAllFn).toHaveBeenCalledTimes(1);
	});

	it('passes a no-op-able function — beforeAll fn runs the hook body', () => {
		const root = mkdtempSync(join(tmpdir(), 'devstack-vitest-wire-'));
		const dir = join(root, '.devstack', 'stacks', 'test');
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, 'manifest.json'), JSON.stringify(minimalManifest()));
		try {
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
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
