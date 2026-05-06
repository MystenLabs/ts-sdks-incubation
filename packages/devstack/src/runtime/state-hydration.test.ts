// State-hydration tests for the reconciler. Pins the load-bearing
// invariant of PR 0: a fresh process loads `Manifest.actionStates`,
// constructs the reconciler with `priorState`, and skips setup actions
// on input-hash match WITHOUT rerunning their (optional) `getStatus`.
//
// This is what lets `publish()`, `runTransaction()`, and
// `imports({ packages })` ship with no default getStatus while remaining
// idempotent across processes.

import { describe, expect, it, vi } from 'vitest';

import { buildImage } from '../actions/build.js';
import { register } from '../actions/register.js';
import { seed } from '../actions/seed.js';
import { service } from '../actions/service.js';
import { verify } from '../actions/verify.js';
import type { Action, AccountsContext, PortAllocator } from '../core/types.js';
import { RegistryImpl } from '../registry/index.js';
import { createInMemoryPortAllocator } from './port-allocator.js';
import { Reconciler } from './reconcile.js';

const noAccounts: AccountsContext = {
	get: (n) => {
		throw new Error(`accounts.get('${n}') in fixture`);
	},
	has: () => false,
	names: () => [],
};

const baseCtx = (registry = new RegistryImpl(), ports?: PortAllocator) => ({
	appName: 'fixture',
	appDir: '/tmp/fixture',
	stack: 'main',
	network: 'localnet' as const,
	registry,
	accounts: noAccounts,
	ports: ports ?? createInMemoryPortAllocator(),
});

describe('Reconciler — priorState hydration', () => {
	it('skips a setup action with no getStatus when priorState matches the input hash', async () => {
		const run = vi.fn(async () => undefined);
		const action = register({
			name: 'app.setup',
			inputs: { v: 1 },
			run,
			// no getStatus — the new contract: hash-match alone drives skip
		});
		const reconciler = new Reconciler();
		const result1 = await reconciler.cycle([action], baseCtx());
		expect(result1.statuses.get('app.setup')).toBe('ok');
		expect(run).toHaveBeenCalledTimes(1);

		const persisted = reconciler.serializeState();
		expect(persisted['app.setup']).toMatchObject({ lastInputHash: expect.any(String) });

		// New process: fresh reconciler with priorState. Same inputs →
		// hash matches → skip without rerunning `run`.
		const run2 = vi.fn(async () => undefined);
		const action2 = register({ name: 'app.setup', inputs: { v: 1 }, run: run2 });
		const reconciler2 = new Reconciler({ priorState: persisted });
		const result2 = await reconciler2.cycle([action2], baseCtx());
		expect(result2.statuses.get('app.setup')).toBe('ok');
		expect(run2).not.toHaveBeenCalled();
	});

	it('reruns a setup action when input hash drifts (new inputs)', async () => {
		const run1 = vi.fn(async () => undefined);
		const a1 = register({ name: 'app.setup', inputs: { v: 1 }, run: run1 });
		const r1 = new Reconciler();
		await r1.cycle([a1], baseCtx());
		const persisted = r1.serializeState();
		expect(run1).toHaveBeenCalledTimes(1);

		const run2 = vi.fn(async () => undefined);
		// Same name, different inputs.
		const a2 = register({ name: 'app.setup', inputs: { v: 2 }, run: run2 });
		const r2 = new Reconciler({ priorState: persisted });
		await r2.cycle([a2], baseCtx());
		expect(run2).toHaveBeenCalledTimes(1);
	});

	it('still probes getStatus on a Service action with priorState (liveness)', async () => {
		// Cold cycle: probe ok=true → skip run, mark healthy. State is
		// persisted because the action reached `healthy`.
		const probe = vi.fn(async () => ({ ok: true, detail: 'up' }));
		const a = service({ name: 'app.svc', inputs: { v: 1 }, run: vi.fn(), getStatus: probe });
		const r = new Reconciler();
		await r.cycle([a], baseCtx());
		expect(probe).toHaveBeenCalledTimes(1);

		const persisted = r.serializeState();
		expect(persisted['app.svc']).toBeDefined();

		// Warm cycle: hash match + probe ok → skip run, probe still consulted.
		const probe2 = vi.fn(async () => ({ ok: true, detail: 'still up' }));
		const run2 = vi.fn();
		const a2 = service({ name: 'app.svc', inputs: { v: 1 }, run: run2, getStatus: probe2 });
		const r2 = new Reconciler({ priorState: persisted });
		await r2.cycle([a2], baseCtx());
		expect(probe2).toHaveBeenCalledTimes(1);
		expect(run2).not.toHaveBeenCalled();
	});

	it('reruns a Service action when getStatus reports !ok even with priorState', async () => {
		// Cold cycle: probe ok=true → skip run, persist state.
		const probe = vi.fn(async () => ({ ok: true, detail: 'up' }));
		const a = service({ name: 'app.svc', inputs: { v: 1 }, run: vi.fn(), getStatus: probe });
		const r = new Reconciler();
		await r.cycle([a], baseCtx());

		const persisted = r.serializeState();
		// Next process: same hash, but probe says !ok → run fires.
		const run2 = vi.fn(async () => undefined);
		const probe2 = vi.fn(async () => ({ ok: false, detail: 'container died' }));
		const a2 = service({ name: 'app.svc', inputs: { v: 1 }, run: run2, getStatus: probe2 });
		const r2 = new Reconciler({ priorState: persisted });
		await r2.cycle([a2], baseCtx());
		expect(probe2).toHaveBeenCalledTimes(1);
		expect(run2).toHaveBeenCalledTimes(1);
	});

	it('always reruns Verify regardless of priorState', async () => {
		const probe = vi.fn(async () => ({ ok: true, detail: 'invariant holds' }));
		const v = verify({ name: 'app.invariant', inputs: {}, getStatus: probe });
		const r = new Reconciler({
			priorState: { 'app.invariant': { lastInputHash: 'irrelevant' } },
		});
		await r.cycle([v], baseCtx());
		expect(probe).toHaveBeenCalledTimes(1);
	});

	it('serializeState only emits healthy actions with a lastInputHash', async () => {
		const action: Action = buildImage({
			name: 'app.build',
			inputs: { tag: 'v1' },
			run: async () => {
				throw new Error('boom');
			},
		});
		const r = new Reconciler();
		await r.cycle([action], baseCtx());
		const persisted = r.serializeState();
		expect(persisted).toEqual({});
	});

	it('seed actions with no getStatus skip on warm hash match (no marker file needed)', async () => {
		const run = vi.fn(async () => undefined);
		const a = seed({ name: 'app.seed', inputs: { recipients: ['a', 'b'] }, run });
		const r = new Reconciler();
		await r.cycle([a], baseCtx());
		expect(run).toHaveBeenCalledTimes(1);

		const persisted = r.serializeState();
		const run2 = vi.fn(async () => undefined);
		const a2 = seed({ name: 'app.seed', inputs: { recipients: ['a', 'b'] }, run: run2 });
		const r2 = new Reconciler({ priorState: persisted });
		await r2.cycle([a2], baseCtx());
		expect(run2).not.toHaveBeenCalled();
	});

	it('hydration of a name not in the current graph is harmless', async () => {
		const run = vi.fn(async () => undefined);
		const a = register({ name: 'app.b', inputs: { v: 1 }, run });
		const r = new Reconciler({
			priorState: {
				'app.a': { lastInputHash: 'stale' },
				'app.b': { lastInputHash: 'mismatch' },
			},
		});
		await r.cycle([a], baseCtx());
		// app.b's prior hash doesn't match current → run fires.
		expect(run).toHaveBeenCalledTimes(1);
	});
});
