import { describe, expect, it } from 'vitest';
import { emit } from '../actions/emit.js';
import { register } from '../actions/register.js';
import type { AccountsContext } from '../core/types.js';
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
