// BuildContext.use(member) — direct member-ref accessor for the
// substrate's BuildContext. Pinned behaviors:
//
//   1. Happy path: `use(member)` resolves to the upstream's resolved
//      value, identical to what `get(member.provides)` returns.
//   2. Mixed access: a single acquire body may call `get(tag)` AND
//      `use(member)` interchangeably on different upstreams.
//   3. Branded compile-time error: a member whose provided tag id is
//      NOT in the acquiring plugin's `Consumes` surfaces
//      `__MemberNotConsumedError<Id>` at the argument position (the
//      `@ts-expect-error` directives anchor this).
//   4. Reaching outside the acquiring plugin's declared `consumes` is
//      a runtime guard — the type system normally rules it out, but
//      defensive code throws on the synchronous lookup.

import { Effect, Scope } from 'effect';
import { describe, expect, it } from '@effect/vitest';

import { defineTag } from '../../src/substrate/tag.ts';
import { defineNodePlugin } from '../../src/api/define-plugin.ts';
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

interface AliceValue {
	readonly address: string;
}
interface PackageValue {
	readonly packageId: string;
}

const AliceTag = defineTag<'account/alice', AliceValue>('account/alice', 'account');
const PackageTag = defineTag<'package:demo', PackageValue>('package:demo', 'package');

const alice = defineNodePlugin({
	provides: AliceTag,
	consumes: [] as const,
	kind: 'leaf-long-running',
	acquire: () => Effect.succeed<AliceValue>({ address: '0xa11ce' }),
});

const demoPackage = defineNodePlugin({
	provides: PackageTag,
	consumes: [] as const,
	kind: 'leaf-long-running',
	acquire: () => Effect.succeed<PackageValue>({ packageId: '0xdeadbeef' }),
});

// A free-standing member that is intentionally NOT in any of the
// downstream plugins' `consumes` tuples — used for the runtime
// negative test and the compile-time negative test below.
const StrangerTag = defineTag<'account/stranger', AliceValue>('account/stranger', 'account');
const stranger = defineNodePlugin({
	provides: StrangerTag,
	consumes: [] as const,
	kind: 'leaf-long-running',
	acquire: () => Effect.succeed<AliceValue>({ address: '0xbad' }),
});

// --- Test helpers -------------------------------------------------------

/** Synthesize a DepNode for a hypothetical consumer plugin: its
 *  `consumes` tuple is the provided tags of `upstreams`, and the
 *  positional `upstreamKeys` index into the entries registered in the
 *  registry. We construct a minimal `member` shape — the BuildContext
 *  walker only reads `consumes[i].id` and `upstreamKeys[i]`. */
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

/** Build a registry pre-populated with ready entries for the given
 *  (key, value) pairs. The supervisor normally drives this; tests
 *  fast-forward by calling `markReady` directly. */
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
			// The key was just inserted above — UnknownDependency cannot
			// fire here, so orDie keeps the helper's E channel honest.
			yield* Effect.orDie(registry.markReady(key, value));
		}
		return registry;
	});

// --- Runtime behavior ---------------------------------------------------

describe('BuildContext.use(member)', () => {
	it.effect('returns the same resolved value as get(member.provides)', () =>
		Effect.scoped(
			Effect.gen(function* () {
				const aliceKey = pluginKey('account/alice#0');
				const registry = yield* setupRegistry([{ key: aliceKey, value: { address: '0xa11ce' } }]);
				const node = makeConsumerNode([alice], [aliceKey]);
				const ctx = buildContextFor(registry, node);

				const viaUse = ctx.use(alice);
				const viaGet = ctx.get(alice.provides);
				expect(viaUse).toEqual(viaGet);
				expect(viaUse).toEqual({ address: '0xa11ce' });
			}),
		),
	);

	it.effect('mixed get + use within a single acquire body', () =>
		Effect.scoped(
			Effect.gen(function* () {
				const aliceKey = pluginKey('account/alice#0');
				const pkgKey = pluginKey('package:demo#1');
				const registry = yield* setupRegistry([
					{ key: aliceKey, value: { address: '0xa11ce' } },
					{ key: pkgKey, value: { packageId: '0xdeadbeef' } },
				]);
				const node = makeConsumerNode([alice, demoPackage], [aliceKey, pkgKey]);
				const ctx = buildContextFor(registry, node);

				// One body reads upstream A via `get(tag)` and upstream B via
				// `use(member)`. Both flow through the same tag-id index.
				const aliceVal = ctx.get(alice.provides);
				const pkgVal = ctx.use(demoPackage);
				expect(aliceVal).toEqual({ address: '0xa11ce' });
				expect(pkgVal).toEqual({ packageId: '0xdeadbeef' });

				// Converse — use for alice, get for package — same answers.
				const aliceVal2 = ctx.use(alice);
				const pkgVal2 = ctx.get(demoPackage.provides);
				expect(aliceVal2).toEqual({ address: '0xa11ce' });
				expect(pkgVal2).toEqual({ packageId: '0xdeadbeef' });
			}),
		),
	);

	it.effect('throws when use() reaches outside the declared consumes', () =>
		Effect.scoped(
			Effect.gen(function* () {
				const aliceKey = pluginKey('account/alice#0');
				const registry = yield* setupRegistry([{ key: aliceKey, value: { address: '0xa11ce' } }]);
				// Node declares only `alice` in consumes; trying to
				// `use(stranger)` exercises the defensive walker. We cast
				// the ctx to the wider shape `buildContextFor` returns at
				// runtime so the runtime check fires without the type
				// system's branded error intercepting it first.
				const node = makeConsumerNode([alice], [aliceKey]);
				const ctx = buildContextFor(registry, node);
				const wideCtx = ctx as { use: (m: typeof stranger) => unknown };

				expect(() => wideCtx.use(stranger)).toThrow(
					/tag 'account\/stranger' not in this plugin's declared consumes/,
				);
			}),
		),
	);
});

// --- Compile-time test --------------------------------------------------
//
// This declaration never executes — it exists so `tsc` rejects the body.
// The `@ts-expect-error` directives anchor the load-bearing claim:
// `ctx.use(member)` of a member whose provided tag is NOT in this
// plugin's `Consumes` surfaces a diagnostic at the call site (the
// branded `__MemberNotConsumedError<Id>`). The diagnostic must name
// the offending id, not a generic "not assignable" wall of text.

const _compileTimeNegative = defineNodePlugin({
	provides: defineTag<'consumer/x', { readonly ok: true }>('consumer/x', 'consumer'),
	consumes: [AliceTag] as const,
	kind: 'leaf-long-running',
	acquire: (ctx) =>
		Effect.sync(() => {
			// Positive: alice IS in consumes.
			ctx.use(alice);
			// Positive (parallel): same lookup via the tag.
			ctx.get(AliceTag);
			// Negative: stranger is NOT in this plugin's consumes.
			// @ts-expect-error — __MemberNotConsumedError<'account/stranger'>
			ctx.use(stranger);
			// Negative: demoPackage is NOT in this plugin's consumes.
			// @ts-expect-error — __MemberNotConsumedError<'package:demo'>
			ctx.use(demoPackage);
			return { ok: true } as const;
		}),
});
void _compileTimeNegative;
