// `consumeMembers` — plugin-authoring helper that hides the §14
// localized typed-cast around `ctx.use(member)` for member-tuple
// walks. Three call sites consume it: wallet, account, walrus.
//
// Invariants under test:
//   1. `consumesTags` is the per-member `.provides` projection, in
//      tuple order.
//   2. `projectInScope(ctx)` returns the resolved values in tuple
//      order — same as a manual `members.map((m) => ctx.use(m))` walk.
//   3. Empty member tuple: `consumesTags` is `[]`, `projectInScope`
//      returns `[]`.

import { Effect, Scope } from 'effect';
import { describe, expect, it } from '@effect/vitest';

import { consumeMember, consumeMembers } from '../../src/api/consume-members.ts';
import { defineNodePlugin } from '../../src/api/define-plugin.ts';
import { defineTag } from '../../src/substrate/tag.ts';
import { pluginKey, type PluginKey } from '../../src/substrate/brand.ts';
import {
	buildContextFor,
	makeEntry,
	makeRegistry,
	type PluginEntry,
	type PluginRegistry,
} from '../../src/substrate/runtime/lifecycle/plugin-registry.ts';
import type { DepNode } from '../../src/substrate/runtime/lifecycle/dep-graph.ts';
import type { AnyMember } from '../../src/substrate/plugin.ts';

// --- Fixtures -----------------------------------------------------------

interface AccountValueLike {
	readonly address: string;
}

const AliceTag = defineTag<'account/alice', AccountValueLike>('account/alice', 'account');
const BobTag = defineTag<'account/bob', AccountValueLike>('account/bob', 'account');

const alice = defineNodePlugin({
	provides: AliceTag,
	consumes: [] as const,
	kind: 'leaf-long-running',
	acquire: () => Effect.succeed<AccountValueLike>({ address: '0xa11ce' }),
});

const bob = defineNodePlugin({
	provides: BobTag,
	consumes: [] as const,
	kind: 'leaf-long-running',
	acquire: () => Effect.succeed<AccountValueLike>({ address: '0xb0b' }),
});

const makeConsumerNode = (
	upstreams: ReadonlyArray<AnyMember>,
	upstreamKeys: ReadonlyArray<PluginKey>,
): DepNode => ({
	key: pluginKey('consumer#0'),
	member: {
		...alice,
		provides: defineTag<'consumer', unknown>('consumer', 'consumer'),
		consumes: upstreams.map((m) => m.provides),
	} as AnyMember,
	compositeParent: null,
	upstreamKeys,
});

const setupRegistry = (
	entries: ReadonlyArray<{ readonly key: PluginKey; readonly value: unknown }>,
): Effect.Effect<PluginRegistry, never, Scope.Scope> =>
	Effect.gen(function* () {
		const parent = yield* Effect.scope;
		const pluginEntries = new Map<PluginKey, PluginEntry>();
		for (const { key } of entries) {
			const node: DepNode = {
				key,
				member: alice as AnyMember,
				compositeParent: null,
				upstreamKeys: [],
			};
			const entry = yield* makeEntry(node, parent);
			pluginEntries.set(key, entry);
		}
		const registry = makeRegistry(pluginEntries, () => Effect.void);
		for (const { key, value } of entries) {
			yield* Effect.orDie(registry.markReady(key, value));
		}
		return registry;
	});

// --- Tests --------------------------------------------------------------

describe('consumeMembers', () => {
	it('projects consumesTags as members.map(m => m.provides)', () => {
		const consumed = consumeMembers([alice, bob] as const);
		expect(consumed.consumesTags).toEqual([alice.provides, bob.provides]);
	});

	it('handles the empty tuple', () => {
		const consumed = consumeMembers([] as const);
		expect(consumed.consumesTags).toEqual([]);
	});

	it.effect('projectInScope returns resolved values in tuple order', () =>
		Effect.scoped(
			Effect.gen(function* () {
				const aliceKey = pluginKey('account/alice#0');
				const bobKey = pluginKey('account/bob#1');
				const registry = yield* setupRegistry([
					{ key: aliceKey, value: { address: '0xa11ce' } },
					{ key: bobKey, value: { address: '0xb0b' } },
				]);
				const node = makeConsumerNode([alice, bob], [aliceKey, bobKey]);
				const ctx = buildContextFor(registry, node);

				const consumed = consumeMembers([alice, bob] as const);
				const resolved = consumed.projectInScope(ctx);

				expect(resolved).toEqual([{ address: '0xa11ce' }, { address: '0xb0b' }]);
				// Identical to a manual ctx.use walk.
				expect(resolved[0]).toEqual(ctx.use(alice));
				expect(resolved[1]).toEqual(ctx.use(bob));
			}),
		),
	);

	it.effect('projectInScope on the empty tuple returns []', () =>
		Effect.scoped(
			Effect.gen(function* () {
				const registry = yield* setupRegistry([]);
				const node = makeConsumerNode([], []);
				const ctx = buildContextFor(registry, node);

				const consumed = consumeMembers([] as const);
				expect(consumed.projectInScope(ctx)).toEqual([]);
			}),
		),
	);
});

describe('consumeMember', () => {
	it('projects consumesTag as member.provides', () => {
		const consumed = consumeMember(alice);
		expect(consumed.consumesTag).toBe(alice.provides);
	});

	it.effect('projectInScope returns the resolved value', () =>
		Effect.scoped(
			Effect.gen(function* () {
				const aliceKey = pluginKey('account/alice#0');
				const registry = yield* setupRegistry([{ key: aliceKey, value: { address: '0xa11ce' } }]);
				const node = makeConsumerNode([alice], [aliceKey]);
				const ctx = buildContextFor(registry, node);

				const consumed = consumeMember(alice);
				const resolved = consumed.projectInScope(ctx);

				expect(resolved).toEqual({ address: '0xa11ce' });
				// Identical to a manual ctx.use call.
				expect(resolved).toEqual(ctx.use(alice));
			}),
		),
	);
});
