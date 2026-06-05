import { Effect } from 'effect';
import { describe, expect, it } from '@effect/vitest';

import {
	WARM_BASELINE_SNAPSHOT_ID,
	computeWarmFingerprint,
} from '../../../src/orchestrators/warm/fingerprint.ts';
import type { SupervisedStack } from '../../../src/substrate/runtime/supervisor/types.ts';
import type { AnyPlugin } from '../../../src/substrate/plugin.ts';
import type { DevstackOptions } from '../../../src/substrate/options.ts';

// -----------------------------------------------------------------------------
// Minimal fakes — the fingerprint reads the resolved lifecycle graph plus
// stack options. These objects carry only the plugin fields the graph resolver
// needs and are cast to the runtime plugin type.
// -----------------------------------------------------------------------------

interface FakeMemberSpec {
	readonly id: string;
	readonly pluginKey?: string;
	readonly role?: 'service' | 'task';
	readonly section?: 'service' | 'package' | 'account' | 'action' | 'app' | 'other';
	readonly endpointSection?: string;
	readonly deps?: ReadonlyArray<string>;
	readonly watch?: ReadonlyArray<string>;
	readonly watchCascade?: boolean;
	readonly keepAliveOnRestore?: boolean;
	readonly warmInputs?: unknown;
}

const fakeMember = (spec: FakeMemberSpec): AnyPlugin =>
	({
		id: spec.id,
		...(spec.pluginKey === undefined ? {} : { pluginKey: spec.pluginKey }),
		role: spec.role ?? 'service',
		section: spec.section ?? 'service',
		...(spec.endpointSection === undefined ? {} : { endpointSection: spec.endpointSection }),
		dependsOn: (spec.deps ?? []).map((id) => ({ id })),
		...(spec.watch === undefined
			? {}
			: {
					watch: {
						paths: spec.watch,
						...(spec.watchCascade === undefined ? {} : { cascade: spec.watchCascade }),
					},
				}),
		keepAliveOnRestore: spec.keepAliveOnRestore === true,
		...(spec.warmInputs === undefined ? {} : { warmInputs: spec.warmInputs }),
	}) as unknown as AnyPlugin;

const fakeStack = (
	members: ReadonlyArray<FakeMemberSpec>,
	options: DevstackOptions = {},
): SupervisedStack => ({
	_tag: 'Stack',
	members: members.map(fakeMember),
	options,
});

const DEVSTACK_VERSION = '1.0.0';

const fingerprint = (args: {
	readonly stack: SupervisedStack;
	readonly devstackVersion?: string;
}): Effect.Effect<string> =>
	computeWarmFingerprint({
		stack: args.stack,
		devstackVersion: args.devstackVersion ?? DEVSTACK_VERSION,
	}).pipe(Effect.orDie);

describe('warm fingerprint', () => {
	it('exposes the baseline snapshot id matching the descriptor pattern', () => {
		expect(WARM_BASELINE_SNAPSHOT_ID).toBe('warm-baseline');
		expect(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(WARM_BASELINE_SNAPSHOT_ID)).toBe(true);
	});

	it.effect('is deterministic across member reordering when plugin keys are stable', () =>
		Effect.gen(function* () {
			const a = fakeStack([
				{ id: 'sui', pluginKey: 'sui' },
				{ id: 'walrus', pluginKey: 'walrus', deps: ['sui'] },
				{ id: 'seal', pluginKey: 'seal', deps: ['sui', 'walrus'] },
			]);
			const b = fakeStack([
				{ id: 'seal', pluginKey: 'seal', deps: ['walrus', 'sui'] },
				{ id: 'sui', pluginKey: 'sui' },
				{ id: 'walrus', pluginKey: 'walrus', deps: ['sui'] },
			]);
			const fa = yield* fingerprint({ stack: a });
			const fb = yield* fingerprint({ stack: b });
			expect(fa).toBe(fb);
			expect(/^[a-f0-9]{64}$/.test(fa)).toBe(true);
		}),
	);

	it.effect('CHANGES when implicit ordinal plugin keys change', () =>
		Effect.gen(function* () {
			const a = fakeStack([{ id: 'sui' }, { id: 'walrus', deps: ['sui'] }]);
			const b = fakeStack([{ id: 'walrus', deps: ['sui'] }, { id: 'sui' }]);
			const fa = yield* fingerprint({ stack: a });
			const fb = yield* fingerprint({ stack: b });
			expect(fa).not.toBe(fb);
		}),
	);

	it.effect('is stable when only the display-only renderer option changes', () =>
		Effect.gen(function* () {
			const tui = fakeStack([{ id: 'sui' }], { stackName: 's', renderer: 'tui' });
			const silent = fakeStack([{ id: 'sui' }], { stackName: 's', renderer: 'silent' });
			const fa = yield* fingerprint({ stack: tui });
			const fb = yield* fingerprint({ stack: silent });
			expect(fa).toBe(fb);
		}),
	);

	it.effect('is stable across option-key ordering', () =>
		Effect.gen(function* () {
			const a = fakeStack([{ id: 'sui' }], { stackName: 's', stateDir: '/tmp/x' });
			const b = fakeStack([{ id: 'sui' }], { stateDir: '/tmp/x', stackName: 's' });
			const fa = yield* fingerprint({ stack: a });
			const fb = yield* fingerprint({ stack: b });
			expect(fa).toBe(fb);
		}),
	);

	it.effect('CHANGES when a runtime identity option changes', () =>
		Effect.gen(function* () {
			const a = fakeStack([{ id: 'sui' }], { stackName: 'alpha' });
			const b = fakeStack([{ id: 'sui' }], { stackName: 'beta' });
			const fa = yield* fingerprint({ stack: a });
			const fb = yield* fingerprint({ stack: b });
			expect(fa).not.toBe(fb);
		}),
	);

	it.effect('CHANGES when devstackVersion changes', () =>
		Effect.gen(function* () {
			const stack = fakeStack([{ id: 'sui' }]);
			const fa = yield* fingerprint({ stack, devstackVersion: '1.0.0' });
			const fb = yield* fingerprint({ stack, devstackVersion: '1.0.1' });
			expect(fa).not.toBe(fb);
		}),
	);

	it.effect('CHANGES when the member set changes', () =>
		Effect.gen(function* () {
			const a = fakeStack([{ id: 'sui' }]);
			const b = fakeStack([{ id: 'sui' }, { id: 'walrus', deps: ['sui'] }]);
			const fa = yield* fingerprint({ stack: a });
			const fb = yield* fingerprint({ stack: b });
			expect(fa).not.toBe(fb);
		}),
	);

	it.effect('CHANGES when a dependency edge changes', () =>
		Effect.gen(function* () {
			const a = fakeStack([
				{ id: 'sui', pluginKey: 'sui' },
				{ id: 'walrus', pluginKey: 'walrus' },
			]);
			const b = fakeStack([
				{ id: 'sui', pluginKey: 'sui' },
				{ id: 'walrus', pluginKey: 'walrus', deps: ['sui'] },
			]);
			const fa = yield* fingerprint({ stack: a });
			const fb = yield* fingerprint({ stack: b });
			expect(fa).not.toBe(fb);
		}),
	);

	it.effect('CHANGES when watch declarations change', () =>
		Effect.gen(function* () {
			const a = fakeStack([
				{ id: 'pkg', pluginKey: 'pkg', watch: ['contracts/**/*.move', 'contracts/Move.toml'] },
			]);
			const b = fakeStack([
				{
					id: 'pkg',
					pluginKey: 'pkg',
					watch: ['contracts/**/*.move', 'contracts/Move.toml', 'contracts/Move.lock'],
				},
			]);
			const fa = yield* fingerprint({ stack: a });
			const fb = yield* fingerprint({ stack: b });
			expect(fa).not.toBe(fb);
		}),
	);

	it.effect('CHANGES when watch cascade semantics change', () =>
		Effect.gen(function* () {
			const a = fakeStack([
				{ id: 'pkg', pluginKey: 'pkg', watch: ['contracts'], watchCascade: true },
			]);
			const b = fakeStack([
				{ id: 'pkg', pluginKey: 'pkg', watch: ['contracts'], watchCascade: false },
			]);
			const fa = yield* fingerprint({ stack: a });
			const fb = yield* fingerprint({ stack: b });
			expect(fa).not.toBe(fb);
		}),
	);

	it.effect('CHANGES when plugin-declared warm inputs change', () =>
		Effect.gen(function* () {
			const a = fakeStack([
				{
					id: 'account/alice',
					pluginKey: 'account/alice',
					role: 'task',
					section: 'account',
					warmInputs: { funding: [{ coin: 'sui', amountMist: '10000000000' }] },
				},
			]);
			const b = fakeStack([
				{
					id: 'account/alice',
					pluginKey: 'account/alice',
					role: 'task',
					section: 'account',
					warmInputs: { funding: [{ coin: 'sui', amountMist: '1000000000' }] },
				},
			]);
			const fa = yield* fingerprint({ stack: a });
			const fb = yield* fingerprint({ stack: b });
			expect(fa).not.toBe(fb);
		}),
	);

	it.effect('fails with WarmFingerprintError when the lifecycle graph is invalid', () =>
		Effect.gen(function* () {
			const stack = fakeStack([{ id: 'sui' }, { id: 'sui' }]);
			const error = yield* computeWarmFingerprint({
				stack,
				devstackVersion: DEVSTACK_VERSION,
			}).pipe(Effect.flip);
			expect(error._tag).toBe('WarmFingerprintError');
			expect(error.detail).toContain('dependency graph');
			expect(error.path).toBeUndefined();
		}),
	);
});
