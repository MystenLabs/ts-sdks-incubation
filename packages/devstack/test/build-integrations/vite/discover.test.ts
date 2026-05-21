// Unit tests for the identity discovery resolver.

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from '@effect/vitest';

import { discoverIdentity } from '../../../src/build-integrations/vite/discover.ts';
import { ViteIdentityResolutionError } from '../../../src/build-integrations/vite/errors.ts';

const withEnv = (key: string, value: string | undefined, run: () => void): void => {
	const prior = process.env[key];
	if (value === undefined) delete process.env[key];
	else process.env[key] = value;
	try {
		run();
	} finally {
		if (prior === undefined) delete process.env[key];
		else process.env[key] = prior;
	}
};

describe('discoverIdentity', () => {
	it('returns the canonical stack-scoped manifest path (cwd-walkup, not HOME)', () => {
		const dir = mkdtempSync(join(tmpdir(), 'devstack-vite-discover-'));
		const ident = discoverIdentity({
			cwd: dir,
			app: 'wallet',
			stack: 'main',
		});
		// Path matches `<cwd>/.devstack/stacks/<stack>/manifest.json` —
		// the supervisor's write path (NOT the legacy HOME-rooted shape).
		expect(ident.manifestPath).toBe(join(dir, '.devstack', 'stacks', 'main', 'manifest.json'));
		expect(ident.app).toBe('wallet');
		expect(ident.stack).toBe('main');
		expect(ident.stateDir).toBe(join(dir, '.devstack'));
	});

	it('reads app from package.json walk-up and un-scopes it', () => {
		const root = mkdtempSync(join(tmpdir(), 'devstack-vite-walk-'));
		const child = join(root, 'src', 'app');
		mkdirSync(child, { recursive: true });
		writeFileSync(join(root, 'package.json'), JSON.stringify({ name: '@scope/wallet-demo' }));
		const ident = discoverIdentity({ cwd: child });
		expect(ident.app).toBe('wallet-demo');
		expect(ident.stack).toBe('main');
	});

	it('uses DEVSTACK_STACK when no stack option is passed', () => {
		const dir = mkdtempSync(join(tmpdir(), 'devstack-vite-stack-'));
		withEnv('DEVSTACK_STACK', 'feature', () => {
			const ident = discoverIdentity({ cwd: dir, app: 'demo' });
			expect(ident.stack).toBe('feature');
			expect(ident.manifestPath).toBe(join(dir, '.devstack', 'stacks', 'feature', 'manifest.json'));
		});
	});

	it("defaults stack to 'main' when DEVSTACK_STACK is unset", () => {
		const dir = mkdtempSync(join(tmpdir(), 'devstack-vite-default-'));
		withEnv('DEVSTACK_STACK', undefined, () => {
			const ident = discoverIdentity({ cwd: dir, app: 'demo' });
			expect(ident.stack).toBe('main');
		});
	});

	it('throws ViteIdentityResolutionError when neither option nor package.json provides an app', () => {
		// Set cwd to a tmpdir guaranteed not to have a parent package.json.
		const dir = mkdtempSync(join(tmpdir(), 'devstack-vite-noapp-'));
		withEnv('DEVSTACK_APP', undefined, () => {
			expect(() => discoverIdentity({ cwd: dir })).toThrow(ViteIdentityResolutionError);
		});
	});
});
