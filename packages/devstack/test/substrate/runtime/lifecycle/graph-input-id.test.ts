import { Effect } from 'effect';
import { describe, expect, it } from '@effect/vitest';

import {
	computeStackGraphInputIdentity,
	type StackGraphInputSource,
} from '../../../../src/substrate/runtime/lifecycle/graph-input-id.ts';
import {
	computedInputIdentity,
	staticInputIdentity,
	type AnyPlugin,
} from '../../../../src/substrate/plugin.ts';
import type { DevstackOptions } from '../../../../src/substrate/options.ts';

// -----------------------------------------------------------------------------
// Minimal fakes — the identity reads the resolved lifecycle graph plus
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
	readonly inputIdentity?: unknown;
	readonly computedInputIdentity?: unknown;
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
		...(spec.inputIdentity === undefined
			? {}
			: { inputIdentity: staticInputIdentity(spec.inputIdentity) }),
		...(spec.computedInputIdentity === undefined
			? {}
			: { inputIdentity: computedInputIdentity(() => Effect.succeed(spec.computedInputIdentity)) }),
	}) as unknown as AnyPlugin;

const fakeStack = (
	members: ReadonlyArray<FakeMemberSpec>,
	options: DevstackOptions = {},
): StackGraphInputSource => ({
	members: members.map(fakeMember),
	options,
});

const DEVSTACK_VERSION = '1.0.0';

const graphInputIdFor = (args: {
	readonly stack: StackGraphInputSource;
	readonly devstackVersion?: string;
}): Effect.Effect<string> =>
	computeStackGraphInputIdentity({
		stack: args.stack,
		devstackVersion: args.devstackVersion ?? DEVSTACK_VERSION,
	}).pipe(
		Effect.map((identity) => identity.graphInputId),
		Effect.orDie,
	);

describe('graph input identity', () => {
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
			const fa = yield* graphInputIdFor({ stack: a });
			const fb = yield* graphInputIdFor({ stack: b });
			expect(fa).toBe(fb);
			expect(/^[a-f0-9]{64}$/.test(fa)).toBe(true);
		}),
	);

	it.effect('CHANGES when implicit ordinal plugin keys change', () =>
		Effect.gen(function* () {
			const a = fakeStack([{ id: 'sui' }, { id: 'walrus', deps: ['sui'] }]);
			const b = fakeStack([{ id: 'walrus', deps: ['sui'] }, { id: 'sui' }]);
			const fa = yield* graphInputIdFor({ stack: a });
			const fb = yield* graphInputIdFor({ stack: b });
			expect(fa).not.toBe(fb);
		}),
	);

	it.effect('is stable when only the display-only renderer option changes', () =>
		Effect.gen(function* () {
			const tui = fakeStack([{ id: 'sui' }], { stackName: 's', renderer: 'tui' });
			const silent = fakeStack([{ id: 'sui' }], { stackName: 's', renderer: 'silent' });
			const fa = yield* graphInputIdFor({ stack: tui });
			const fb = yield* graphInputIdFor({ stack: silent });
			expect(fa).toBe(fb);
		}),
	);

	it.effect('is stable across option-key ordering', () =>
		Effect.gen(function* () {
			const a = fakeStack([{ id: 'sui' }], { stackName: 's', stateDir: '/tmp/x' });
			const b = fakeStack([{ id: 'sui' }], { stateDir: '/tmp/x', stackName: 's' });
			const fa = yield* graphInputIdFor({ stack: a });
			const fb = yield* graphInputIdFor({ stack: b });
			expect(fa).toBe(fb);
		}),
	);

	it.effect('CHANGES when a runtime identity option changes', () =>
		Effect.gen(function* () {
			const a = fakeStack([{ id: 'sui' }], { stackName: 'alpha' });
			const b = fakeStack([{ id: 'sui' }], { stackName: 'beta' });
			const fa = yield* graphInputIdFor({ stack: a });
			const fb = yield* graphInputIdFor({ stack: b });
			expect(fa).not.toBe(fb);
		}),
	);

	it.effect('CHANGES when devstackVersion changes', () =>
		Effect.gen(function* () {
			const stack = fakeStack([{ id: 'sui' }]);
			const fa = yield* graphInputIdFor({ stack, devstackVersion: '1.0.0' });
			const fb = yield* graphInputIdFor({ stack, devstackVersion: '1.0.1' });
			expect(fa).not.toBe(fb);
		}),
	);

	it.effect('CHANGES when the member set changes', () =>
		Effect.gen(function* () {
			const a = fakeStack([{ id: 'sui' }]);
			const b = fakeStack([{ id: 'sui' }, { id: 'walrus', deps: ['sui'] }]);
			const fa = yield* graphInputIdFor({ stack: a });
			const fb = yield* graphInputIdFor({ stack: b });
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
			const fa = yield* graphInputIdFor({ stack: a });
			const fb = yield* graphInputIdFor({ stack: b });
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
			const fa = yield* graphInputIdFor({ stack: a });
			const fb = yield* graphInputIdFor({ stack: b });
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
			const fa = yield* graphInputIdFor({ stack: a });
			const fb = yield* graphInputIdFor({ stack: b });
			expect(fa).not.toBe(fb);
		}),
	);

	it.effect('CHANGES when plugin-declared input identity changes', () =>
		Effect.gen(function* () {
			const a = fakeStack([
				{
					id: 'account/alice',
					pluginKey: 'account/alice',
					role: 'task',
					section: 'account',
					inputIdentity: { funding: [{ coin: 'sui', amountMist: '10000000000' }] },
				},
			]);
			const b = fakeStack([
				{
					id: 'account/alice',
					pluginKey: 'account/alice',
					role: 'task',
					section: 'account',
					inputIdentity: { funding: [{ coin: 'sui', amountMist: '1000000000' }] },
				},
			]);
			const fa = yield* graphInputIdFor({ stack: a });
			const fb = yield* graphInputIdFor({ stack: b });
			expect(fa).not.toBe(fb);
		}),
	);

	it.effect('CHANGES when plugin-computed input identity changes', () =>
		Effect.gen(function* () {
			const a = fakeStack([
				{
					id: 'pkg',
					pluginKey: 'pkg',
					role: 'task',
					section: 'package',
					computedInputIdentity: 'a',
				},
			]);
			const b = fakeStack([
				{
					id: 'pkg',
					pluginKey: 'pkg',
					role: 'task',
					section: 'package',
					computedInputIdentity: 'b',
				},
			]);
			const fa = yield* graphInputIdFor({ stack: a });
			const fb = yield* graphInputIdFor({ stack: b });
			expect(fa).not.toBe(fb);
		}),
	);

	it.effect('CHANGES downstream node input ids when an upstream input identity changes', () =>
		Effect.gen(function* () {
			const a = yield* computeStackGraphInputIdentity({
				stack: fakeStack([
					{ id: 'sui', pluginKey: 'sui', inputIdentity: { indexer: true } },
					{ id: 'package:demo', pluginKey: 'package:demo', deps: ['sui'] },
				]),
				devstackVersion: DEVSTACK_VERSION,
			}).pipe(Effect.orDie);
			const b = yield* computeStackGraphInputIdentity({
				stack: fakeStack([
					{ id: 'sui', pluginKey: 'sui', inputIdentity: { indexer: false } },
					{ id: 'package:demo', pluginKey: 'package:demo', deps: ['sui'] },
				]),
				devstackVersion: DEVSTACK_VERSION,
			}).pipe(Effect.orDie);
			const aPackage = a.nodes.find((node) => node.key === 'package:demo');
			const bPackage = b.nodes.find((node) => node.key === 'package:demo');
			expect(aPackage?.inputId).not.toBe(bPackage?.inputId);
		}),
	);

	it.effect('fails when the lifecycle graph is invalid', () =>
		Effect.gen(function* () {
			const stack = fakeStack([{ id: 'sui' }, { id: 'sui' }]);
			const error = yield* computeStackGraphInputIdentity({
				stack,
				devstackVersion: DEVSTACK_VERSION,
			}).pipe(Effect.flip);
			expect(error._tag).toBe('DuplicateResourceIdError');
		}),
	);
});
