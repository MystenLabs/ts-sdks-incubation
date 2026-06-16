// Degraded offline-status builder — `degradedStatusFromContext`.
//
// `persisted.ts` (the write-mostly projection twin) was deleted. The
// offline `status` command no longer reads a persisted `SubscribableState`;
// when the stack is DOWN it projects the on-disk MANIFEST instead. This
// test pins that projection:
//
//   - identity + endpoints are populated from the manifest (the manifest's
//     `network` carries onto the projection's `network`);
//   - the live-only slices (rows / accounts / packages / errors) are EMPTY
//     (a down stack has no live rows — the same shape a freshly-booted
//     stack starts from, which the status renderer already tolerates);
//   - the result satisfies the closed-vocabulary `SubscribableState` shape
//     (no display vocab leak — `title` / `primary` / `extras` absent).

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { degradedStatusFromContext } from '../../src/cli/main.ts';
import { readStackContext } from '../../src/build-integrations/runtime/read-stack-context.ts';
import type { SubscribableState } from '../../src/substrate/projection.ts';

const roots: Array<string> = [];

const seedManifest = (): string => {
	const root = mkdtempSync(join(tmpdir(), 'devstack-degraded-status-'));
	roots.push(root);
	writeFileSync(
		join(root, 'manifest.json'),
		JSON.stringify({
			identity: { app: 'arena', stack: 'main', network: 'localnet' },
			manifestVersion: 1,
			endpoints: {
				'rpc#0:rpc': {
					name: 'rpc',
					url: 'http://127.0.0.1:9000',
					displayUrl: null,
					wireProtocol: 'http',
					pluginKey: 'rpc#0',
					endpointKey: 'rpc#0:rpc',
				},
				'wallet#0:wallet-app': {
					name: 'wallet-app',
					url: 'http://127.0.0.1:39200',
					displayUrl: 'http://wallet.localhost',
					wireProtocol: 'http',
					pluginKey: 'wallet#0',
					endpointKey: 'wallet#0:wallet-app',
				},
			},
			extras: {},
		}),
		'utf8',
	);
	return join(root, 'manifest.json');
};

describe('degradedStatusFromContext', () => {
	afterEach(() => {
		for (const root of roots.splice(0)) {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it('populates identity + endpoints from the manifest and leaves live slices empty', () => {
		const ctx = readStackContext({ manifestPath: seedManifest() });
		const state = degradedStatusFromContext(ctx);

		// Identity — `network` carries onto the projection's `network`.
		expect(state.identity).toEqual({ app: 'arena', stack: 'main', network: 'localnet' });

		// Endpoints — re-branded, `registeredAt` unknown offline → 0. The
		// registry sorts by name (`rpc` < `wallet-app`).
		expect(state.endpoints).toEqual([
			{
				endpointKey: 'rpc#0:rpc',
				pluginKey: 'rpc#0',
				name: 'rpc',
				url: 'http://127.0.0.1:9000',
				displayUrl: null,
				wireProtocol: 'http',
				registeredAt: 0,
			},
			{
				endpointKey: 'wallet#0:wallet-app',
				pluginKey: 'wallet#0',
				name: 'wallet-app',
				url: 'http://127.0.0.1:39200',
				displayUrl: 'http://wallet.localhost',
				wireProtocol: 'http',
				registeredAt: 0,
			},
		]);

		// Live-only slices are empty — a down stack has no live rows.
		expect(state.rows).toEqual([]);
		expect(state.accounts).toEqual([]);
		expect(state.packages).toEqual([]);
		expect(state.errors).toEqual([]);
		expect(state.stackBuild).toEqual([]);

		// Baseline cycle carried straight from `emptyProjection()`.
		expect(state.cycle).toEqual({ id: 0, startedAt: 0, phase: 'booting' });
		expect(state.lastEvent).toEqual({ seq: 0, at: 0 });
	});

	it('satisfies the closed-vocabulary SubscribableState shape (no display vocab leak)', () => {
		const ctx = readStackContext({ manifestPath: seedManifest() });
		const state = degradedStatusFromContext(ctx);

		// The exact closed key set from `substrate/projection.ts`
		// (`__ProjectionFieldsClosed`). No `title` / `primary` / `extras`.
		expect(Object.keys(state).sort()).toEqual(
			[
				'accounts',
				'cycle',
				'endpoints',
				'errors',
				'identity',
				'lastEvent',
				'packages',
				'rows',
				'stackBuild',
			].sort(),
		);
		expect('title' in state).toBe(false);
		expect('primary' in state).toBe(false);
		expect('extras' in state).toBe(false);

		// Type-level assertion: assignable to `SubscribableState`.
		const _typed: SubscribableState = state;
		void _typed;
	});

	it('projects an endpoint-less manifest to empty endpoints', () => {
		const root = mkdtempSync(join(tmpdir(), 'devstack-degraded-status-'));
		roots.push(root);
		writeFileSync(
			join(root, 'manifest.json'),
			JSON.stringify({
				identity: { app: 'arena', stack: 'main', network: 'localnet' },
				manifestVersion: 1,
				endpoints: {},
				extras: {},
			}),
			'utf8',
		);
		const ctx = readStackContext({ manifestPath: join(root, 'manifest.json') });
		const state = degradedStatusFromContext(ctx);

		expect(state.identity).toEqual({ app: 'arena', stack: 'main', network: 'localnet' });
		expect(state.endpoints).toEqual([]);
		expect(state.rows).toEqual([]);
	});
});
