// `coldStartUrl` — conventional-route fallback tests.

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from '@effect/vitest';

import {
	coldStartUrl,
	NoConventionalRouteError,
	tryColdStartUrl,
	readAppName,
	type ConventionalRoute,
} from '../../../src/build-integrations/runtime/index.ts';
import { withTempRootSync } from '../../helpers/with-temp-root.ts';

const ENV_KEYS = ['DEVSTACK_STACK'] as const;
const saved: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};
beforeEach(() => {
	for (const k of ENV_KEYS) saved[k] = process.env[k];
	for (const k of ENV_KEYS) delete process.env[k];
});
afterEach(() => {
	for (const k of ENV_KEYS) {
		const v = saved[k];
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
});

const routes = new Map<string, ConventionalRoute>([
	['sui-rpc', { service: 'sui-rpc', port: 5174, wireProtocol: 'http' }],
	['frontend.dev-server', { service: 'dev', port: 5175, wireProtocol: 'http' }],
]);

describe('coldStartUrl', () => {
	it('builds <service>.<app>.localhost for main stack', () => {
		const url = coldStartUrl('sui-rpc', { routes, app: 'demo', stack: 'main' });
		expect(url).toBe('http://sui-rpc.demo.localhost:5174');
	});

	it('keeps <service> first for non-main stack', () => {
		const url = coldStartUrl('sui-rpc', { routes, stack: 'feature-x', app: 'demo' });
		expect(url).toBe('http://sui-rpc.feature-x.demo.localhost:5174');
	});

	it('honors DEVSTACK_STACK env when stack is not passed', () => {
		process.env.DEVSTACK_STACK = 'feat';
		const url = coldStartUrl('sui-rpc', { routes, app: 'demo' });
		expect(url).toBe('http://sui-rpc.feat.demo.localhost:5174');
	});

	it('reads DEVSTACK_APP from the injected env bag for app identity', () =>
		// Hermetic: the env bag is passed explicitly, so `process.env` is
		// never consulted. `cwd` points at a temp dir with NO package.json,
		// so `readAppName(cwd)` misses and the only remaining fallback is
		// `basename(cwd)` (the mkdtemp name) — distinct from `injected`.
		// A regression that ignored `env.DEVSTACK_APP` would surface the
		// basename instead, failing this assertion.
		withTempRootSync('devstack-cold-start', (tmp) => {
			const url = coldStartUrl('sui-rpc', {
				routes,
				cwd: tmp,
				env: { DEVSTACK_APP: 'injected' },
			});
			expect(url).toBe('http://sui-rpc.injected.localhost:5174');
		}));

	it('env.DEVSTACK_APP wins over a package.json present in cwd', () =>
		// The precedence rung is `opts.app ?? env.DEVSTACK_APP ?? readAppName(cwd)`.
		// Write a package.json whose name differs from the injected value so
		// the two app-name sources genuinely disagree, then assert the env
		// bag wins. The control assertion (no env bag → package metadata)
		// proves the override is real, not a coincidence of a missing file.
		withTempRootSync('devstack-cold-start', (tmp) => {
			writeFileSync(join(tmp, 'package.json'), JSON.stringify({ name: '@org/from-package' }));
			const injected = coldStartUrl('sui-rpc', {
				routes,
				cwd: tmp,
				env: { DEVSTACK_APP: 'injected' },
			});
			expect(injected).toBe('http://sui-rpc.injected.localhost:5174');
			// Control: drop the env bag and the same cwd resolves to the
			// package.json name — confirming the env value above overrode a
			// present, differing `readAppName(cwd)`.
			const fromPackage = coldStartUrl('sui-rpc', { routes, cwd: tmp, env: {} });
			expect(fromPackage).toBe('http://sui-rpc.from-package.localhost:5174');
		}));

	it('uses package metadata for app identity but keeps the default stack at main', () =>
		withTempRootSync('devstack-cold-start', (tmp) => {
			writeFileSync(join(tmp, 'package.json'), JSON.stringify({ name: '@org/wallet-demo' }));
			const url = coldStartUrl('sui-rpc', { routes, cwd: tmp });
			expect(url).toBe('http://sui-rpc.wallet-demo.localhost:5174');
		}));

	it('throws NoConventionalRouteError for unknown endpoint', () => {
		try {
			coldStartUrl('unknown-endpoint', { routes, app: 'demo' });
			expect.fail('should have thrown');
		} catch (err) {
			expect(err).toBeInstanceOf(NoConventionalRouteError);
			expect((err as NoConventionalRouteError).endpoint).toBe('unknown-endpoint');
			expect((err as NoConventionalRouteError).supported).toContain('sui-rpc');
		}
	});

	it('tryColdStartUrl returns undefined on miss', () => {
		expect(tryColdStartUrl('absent', { routes, app: 'demo' })).toBeUndefined();
	});
});

describe('readAppName', () => {
	it('strips @scope/ prefix', () =>
		withTempRootSync('devstack-app', (tmp) => {
			writeFileSync(join(tmp, 'package.json'), JSON.stringify({ name: '@org/my-app' }));
			expect(readAppName(tmp)).toBe('my-app');
		}));

	it('returns the raw name when unscoped', () =>
		withTempRootSync('devstack-app', (tmp) => {
			writeFileSync(join(tmp, 'package.json'), JSON.stringify({ name: 'plain' }));
			expect(readAppName(tmp)).toBe('plain');
		}));

	it('returns undefined when package.json is missing', () =>
		withTempRootSync('devstack-app', (tmp) => {
			expect(readAppName(tmp)).toBeUndefined();
		}));

	it('returns undefined when name field is missing', () =>
		withTempRootSync('devstack-app', (tmp) => {
			writeFileSync(join(tmp, 'package.json'), JSON.stringify({ version: '1.0.0' }));
			expect(readAppName(tmp)).toBeUndefined();
		}));
});
