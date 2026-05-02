import { describe, expect, it } from 'vitest';
import { emit } from '../actions/emit.js';
import { register } from '../actions/register.js';
import { service } from '../actions/service.js';
import { verify } from '../actions/verify.js';
import type { AccountsContext, ActionRunContext } from '../core/types.js';
import type { ReconcileProgress } from './reconcile.js';
import { Reconciler } from './reconcile.js';
import { RegistryImpl } from '../registry/index.js';

const emptyAccounts: AccountsContext = {
	get: (name) => {
		throw new Error(`accounts.get('${name}'): no accounts declared in this fixture`);
	},
	has: () => false,
	names: () => [],
};

const baseCtx = (registry: RegistryImpl, progress?: (snap: ReconcileProgress) => void) => ({
	appName: 'test',
	appDir: '/tmp',
	stack: 'main' as const,
	network: 'localnet' as const,
	registry,
	accounts: emptyAccounts,
	progress,
});

describe('Reconciler — progress callback', () => {
	it('runs Emits AFTER all non-Emit actions settle in the topo walk (cascade unused when no later dirtying)', async () => {
		// Emit listed first in input order — but the parallel scheduler
		// holds Emits until every non-Emit action has settled, so codegen
		// runs after pkgs even though pkgs has no `needs:` edge. This
		// preserves the "Emit sees a stable dirty set" invariant without
		// needing the cascade.
		const codegen = emit({
			name: 'codegen',
			dependsOnKind: ['packages'],
			inputs: {},
			run: async () => {},
		});
		const pkgs = register({
			name: 'pkgs',
			inputs: {},
			run: async (ctx) => {
				ctx.registry.packages.register({
					name: 'foo',
					packageId: '0x1',
					captured: {},
					network: 'localnet',
				});
			},
		});

		const snapshots: ReconcileProgress[] = [];
		const reconciler = new Reconciler();
		const registry = new RegistryImpl();
		const result = await reconciler.cycle(
			[codegen, pkgs],
			baseCtx(registry, (snap) => {
				snapshots.push({
					statuses: new Map(snap.statuses),
					failures: new Map(snap.failures),
				});
			}),
		);

		// First snapshot: every action queued.
		expect(snapshots[0]?.statuses.get('codegen')).toBe('queued');
		expect(snapshots[0]?.statuses.get('pkgs')).toBe('queued');
		// Both transition through `running` at some point.
		expect(snapshots.some((s) => s.statuses.get('pkgs') === 'running')).toBe(true);
		expect(snapshots.some((s) => s.statuses.get('codegen') === 'running')).toBe(true);
		// pkgs reaches `healthy` BEFORE codegen does (Emit waited for it).
		const pkgsHealthy = snapshots.findIndex((s) => s.statuses.get('pkgs') === 'healthy');
		const codegenHealthy = snapshots.findIndex((s) => s.statuses.get('codegen') === 'healthy');
		expect(pkgsHealthy).toBeGreaterThan(-1);
		expect(codegenHealthy).toBeGreaterThan(-1);
		expect(pkgsHealthy).toBeLessThan(codegenHealthy);
		// Final result: both healthy.
		expect(result.statuses.get('codegen')).toBe('healthy');
		expect(result.statuses.get('pkgs')).toBe('healthy');
	});

	it('emits queued → running → healthy transitions for each action; no `dirty` when nothing cascades', async () => {
		const a = register({ name: 'a', inputs: {}, run: async () => {} });
		const b = register({ name: 'b', inputs: {}, run: async () => {} });

		const snapshots: ReconcileProgress[] = [];
		const reconciler = new Reconciler();
		const registry = new RegistryImpl();
		await reconciler.cycle(
			[a, b],
			baseCtx(registry, (snap) => {
				snapshots.push({
					statuses: new Map(snap.statuses),
					failures: new Map(snap.failures),
				});
			}),
		);

		// First snapshot: both queued.
		expect(snapshots[0]?.statuses.get('a')).toBe('queued');
		expect(snapshots[0]?.statuses.get('b')).toBe('queued');
		// Last snapshot: both healthy.
		const last = snapshots.at(-1);
		expect(last?.statuses.get('a')).toBe('healthy');
		expect(last?.statuses.get('b')).toBe('healthy');
		// At least one snapshot per action shows it `running`.
		expect(snapshots.some((s) => s.statuses.get('a') === 'running')).toBe(true);
		expect(snapshots.some((s) => s.statuses.get('b') === 'running')).toBe(true);
		// No Emits → no `dirty`-marked entries anywhere.
		const sawDirty = snapshots.some((s) => [...s.statuses.values()].includes('dirty'));
		expect(sawDirty).toBe(false);
	});

	it('does not crash when no progress callback is provided', async () => {
		const a = register({ name: 'a', inputs: {}, run: async () => {} });
		const reconciler = new Reconciler();
		const registry = new RegistryImpl();
		const result = await reconciler.cycle([a], baseCtx(registry));
		expect(result.statuses.get('a')).toBe('healthy');
	});
});

describe('Reconciler — skip-predicate priority', () => {
	// A Reconciler instance carries its own `state` map across cycles, so the
	// "prior" branch we want to test is just "two cycles in a row with the
	// same Reconciler". A fresh Reconciler each cycle would always be the
	// cold-cycle branch.

	it('hash mismatch with prior runs even when getStatus.ok=true (drift wins over warm-path)', async () => {
		// The bug we're guarding against: a plugin whose `getStatus` always
		// returns ok (because, say, the docker container is still up) would
		// silently skip on inputs drift before the fix. The reconciler must
		// re-run on hash mismatch regardless of getStatus.
		let runCount = 0;
		const reconciler = new Reconciler();
		const registry = new RegistryImpl();

		const makeAction = (subnet: string) =>
			register({
				name: 'a',
				inputs: { subnet },
				getStatus: async () => ({ ok: true }),
				run: async () => {
					runCount++;
				},
			});

		// Cold cycle: getStatus.ok=true on cold path is allowed to skip
		// (warm-path rehydration). But there's no prior state in memory, so
		// the action runs at least once to establish the hash.
		await reconciler.cycle([makeAction('10.0.0.0/24')], baseCtx(registry));
		const cold = runCount;

		// Same inputs, second cycle: hash matches, getStatus.ok=true → skip.
		await reconciler.cycle([makeAction('10.0.0.0/24')], baseCtx(registry));
		expect(runCount).toBe(cold);

		// Inputs change, third cycle: hash drifts. getStatus still says ok,
		// but the reconciler MUST run because inputs changed.
		await reconciler.cycle([makeAction('10.0.0.0/16')], baseCtx(registry));
		expect(runCount).toBe(cold + 1);
	});

	it('cold cycle with getStatus.ok=true skips (warm-path rehydration)', async () => {
		// Documented design: a Reconciler with no prior state in memory but a
		// `getStatus` that already reports healthy short-circuits — this is
		// what lets seal/sui plugins hydrate from a manifest after restart
		// without re-running expensive containers.
		let runCount = 0;
		const reconciler = new Reconciler();
		const registry = new RegistryImpl();
		const action = register({
			name: 'a',
			inputs: { stable: 'value' },
			getStatus: async () => ({ ok: true }),
			run: async () => {
				runCount++;
			},
		});
		await reconciler.cycle([action], baseCtx(registry));
		expect(runCount).toBe(0);
	});

	it('hash match with getStatus.ok=true skips on subsequent cycles', async () => {
		let runCount = 0;
		let statusOk = false;
		const reconciler = new Reconciler();
		const registry = new RegistryImpl();
		const action = register({
			name: 'a',
			inputs: { stable: 'value' },
			getStatus: async () => ({ ok: statusOk }),
			run: async () => {
				runCount++;
			},
		});
		// Cold cycle: getStatus says not ok → run, prior gets recorded.
		await reconciler.cycle([action], baseCtx(registry));
		expect(runCount).toBe(1);
		// Second cycle: hash matches, getStatus now ok → skip.
		statusOk = true;
		await reconciler.cycle([action], baseCtx(registry));
		expect(runCount).toBe(1);
	});

	it('hash match with no getStatus skips', async () => {
		let runCount = 0;
		const reconciler = new Reconciler();
		const registry = new RegistryImpl();
		const action = register({
			name: 'a',
			inputs: { stable: 'value' },
			run: async () => {
				runCount++;
			},
		});
		await reconciler.cycle([action], baseCtx(registry));
		await reconciler.cycle([action], baseCtx(registry));
		expect(runCount).toBe(1);
	});

	it('getStatus.ok=false runs even on hash match', async () => {
		let runCount = 0;
		const reconciler = new Reconciler();
		const registry = new RegistryImpl();
		const action = register({
			name: 'a',
			inputs: { stable: 'value' },
			getStatus: async () => ({ ok: false }),
			run: async () => {
				runCount++;
			},
		});
		await reconciler.cycle([action], baseCtx(registry));
		await reconciler.cycle([action], baseCtx(registry));
		expect(runCount).toBe(2);
	});
});

describe('Reconciler — provides.registry rehydration', () => {
	it('calls provides.registry on warm-path skip (getStatus.ok=true)', async () => {
		let runCount = 0;
		let rehydrateCount = 0;
		const populateRegistry = async (ctx: ActionRunContext) => {
			rehydrateCount++;
			ctx.registry.services.register({
				name: 'sui-rpc',
				kind: 'rpc',
				url: 'http://127.0.0.1:9000',
				port: 9000,
			});
		};
		const action = service({
			name: 'localnet',
			inputs: { port: 9000 },
			provides: { registry: populateRegistry },
			getStatus: async () => ({ ok: true }),
			run: async () => {
				runCount++;
			},
		});

		const reconciler = new Reconciler();
		const registry = new RegistryImpl();

		// Cold cycle — getStatus.ok=true skips run, but rehydrate still fires.
		await reconciler.cycle([action], baseCtx(registry));
		expect(runCount).toBe(0);
		expect(rehydrateCount).toBe(1);
		expect(registry.services.find('sui-rpc')?.url).toBe('http://127.0.0.1:9000');

		// Second cycle — same as above.
		await reconciler.cycle([action], baseCtx(registry));
		expect(rehydrateCount).toBe(2);
	});

	it('calls provides.registry after a successful run', async () => {
		let rehydrateCount = 0;
		const action = register({
			name: 'a',
			inputs: { x: 1 },
			provides: {
				registry: async () => {
					rehydrateCount++;
				},
			},
			run: async () => {},
		});
		const reconciler = new Reconciler();
		const registry = new RegistryImpl();
		await reconciler.cycle([action], baseCtx(registry));
		expect(rehydrateCount).toBe(1);
	});

	it('provides without a registry hook leaves the registry untouched', async () => {
		const action = register({
			name: 'a',
			inputs: {},
			provides: { capabilities: ['arena.connect-four'] },
			run: async () => {},
		});
		const reconciler = new Reconciler();
		const registry = new RegistryImpl();
		const result = await reconciler.cycle([action], baseCtx(registry));
		expect(result.statuses.get('arena.connect-four')).toBeUndefined();
	});
});

describe('Reconciler — Verify action', () => {
	it('Verify with ok=true marks healthy and runs provides.registry', async () => {
		let rehydrateCount = 0;
		const action = verify({
			name: 'invariant',
			inputs: {},
			provides: {
				registry: async () => {
					rehydrateCount++;
				},
			},
			check: async () => ({ ok: true }),
		});
		const reconciler = new Reconciler();
		const registry = new RegistryImpl();
		const result = await reconciler.cycle([action], baseCtx(registry));
		expect(result.statuses.get('invariant')).toBe('healthy');
		expect(rehydrateCount).toBe(1);
	});

	it('Verify with ok=false marks failed with the detail in the error', async () => {
		const action = verify({
			name: 'invariant',
			inputs: {},
			check: async () => ({ ok: false, detail: 'rpc unreachable' }),
		});
		const reconciler = new Reconciler();
		const registry = new RegistryImpl();
		const result = await reconciler.cycle([action], baseCtx(registry));
		expect(result.statuses.get('invariant')).toBe('failed');
		const err = result.failures.get('invariant');
		expect(err?.message).toMatch(/rpc unreachable/);
	});
});
