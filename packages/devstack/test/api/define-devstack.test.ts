// `defineDevstack` — composer-level invariants.
//
// Pinned behaviors:
//
//   1. D1 auto-mount: `defineDevstack(account('alice'))` compiles AND
//      the resulting stack's `members` tuple has `sui()` prepended at
//      runtime. The user wrote one member; the stack carries two.
//   2. D1 idempotence: when the user passes an explicit sui factory
//      (`sui()`, `sui.local(...)`, `suiFor.live.testnet(...)`), the
//      composer does NOT double-mount.
//   3. No-op when no member consumes sui: the auto-mount predicate
//      reads BOTH "any consumer needs sui" AND "no provider present";
//      a stack of pure leaves with no sui consumption stays
//      sui-free.
//   4. Type-level: the returned `Stack`'s `Members` reflects the
//      auto-injected sui — type narrowing downstream (wallet D6,
//      action consumes, etc.) sees sui as provided.
//   5. Plugin-author symmetry: a user-authored plugin that consumes
//      `SuiTag` triggers the same auto-mount (not just built-ins).

import { Effect } from 'effect';
import { describe, expect, it } from 'vitest';

import { defineDevstack, readStackEngine } from '../../src/api/define-devstack.ts';
import { defineNodePlugin, definePlugin, resource } from '../../src/api/define-plugin.ts';
import { defineTag } from '../../src/substrate/tag.ts';
import { account } from '../../src/plugins/account/index.ts';
import { sui, SuiTag } from '../../src/plugins/sui/index.ts';

// --- Fixtures -----------------------------------------------------------

/** A user-authored plugin that consumes the public `SuiTag`. Exercises
 *  the plugin-author-symmetry path: the auto-mount detection MUST
 *  trigger for any plugin requesting SuiTag, not only the built-ins. */
const CustomTag = defineTag<'custom/needs-sui', { readonly ok: true }>(
	'custom/needs-sui',
	'custom',
);
const customNeedsSui = defineNodePlugin({
	provides: CustomTag,
	consumes: [SuiTag] as const,
	kind: 'leaf-long-running',
	acquire: () => Effect.succeed({ ok: true } as const),
});

/** A leaf with zero upstream — no auto-mount must fire when this is
 *  the only member. */
const LeafTag = defineTag<'leaf/standalone', { readonly id: number }>('leaf/standalone', 'leaf');
const standalone = defineNodePlugin({
	provides: LeafTag,
	consumes: [] as const,
	kind: 'leaf-long-running',
	acquire: () => Effect.succeed({ id: 1 } as const),
});

// --- D1 — auto-mount ----------------------------------------------------

describe('defineDevstack — D1 auto-mount sui()', () => {
	it('prepends sui() when a built-in member consumes sui and no provider is supplied', () => {
		const alice = account('alice');
		const stack = defineDevstack({ members: [alice] });

		expect(readStackEngine(stack).members).toHaveLength(2);
		expect(readStackEngine(stack).members[0]!.provides.id).toBe('sui');
		expect(readStackEngine(stack).members[1]!.provides.id).toBe('account/alice');
	});

	it('prepends sui() when a USER-AUTHORED plugin consumes SuiTag (plugin-author symmetry)', () => {
		const stack = defineDevstack({ members: [customNeedsSui] });

		expect(readStackEngine(stack).members).toHaveLength(2);
		expect(readStackEngine(stack).members[0]!.provides.id).toBe('sui');
		expect(readStackEngine(stack).members[1]!.provides.id).toBe('custom/needs-sui');
	});

	it('does NOT double-mount when the user supplies explicit sui()', () => {
		const explicit = sui();
		const alice = account('alice');
		const stack = defineDevstack({ members: [explicit, alice] });

		expect(readStackEngine(stack).members).toHaveLength(2);
		// The user's explicit sui is preserved — same reference, not a
		// fresh `sui()` injected by the composer.
		expect(readStackEngine(stack).members[0]).toBe(explicit);
		expect(readStackEngine(stack).members[1]).toBe(alice);
	});

	it('does NOT double-mount when the user supplies a non-default sui mode', () => {
		// Any sui mode satisfies the "provides 'sui'" predicate — the
		// auto-mount key is the tag id, not the mode. Exercise with
		// the external mode (a non-default opts shape) to pin that the
		// composer checks the tag id, not the call shape.
		const explicit = sui({ mode: 'live', network: 'testnet' });
		const alice = account('alice');
		const stack = defineDevstack({ members: [explicit, alice] });

		expect(readStackEngine(stack).members).toHaveLength(2);
		expect(readStackEngine(stack).members[0]).toBe(explicit);
	});

	it('does NOT auto-mount when no member consumes sui (predicate is "needed AND missing")', () => {
		const stack = defineDevstack({ members: [standalone] });

		expect(readStackEngine(stack).members).toHaveLength(1);
		expect(readStackEngine(stack).members[0]!.provides.id).toBe('leaf/standalone');
	});

	it('survives a trailing options bag with auto-mount in front', () => {
		const alice = account('alice');
		const stack = defineDevstack({ members: [alice], stackName: 'd1-options-trail' });

		expect(readStackEngine(stack).members).toHaveLength(2);
		expect(readStackEngine(stack).members[0]!.provides.id).toBe('sui');
		expect(stack.options.stackName).toBe('d1-options-trail');
	});

	it('places the auto-mounted sui at index 0 so dep-graph topological order is stable', () => {
		const alice = account('alice');
		const bob = account('bob');
		const stack = defineDevstack({ members: [alice, bob] });

		expect(readStackEngine(stack).members[0]!.provides.id).toBe('sui');
		// User's relative order is preserved after the prepend.
		expect(readStackEngine(stack).members[1]!.provides.id).toBe('account/alice');
		expect(readStackEngine(stack).members[2]!.provides.id).toBe('account/bob');
	});
});

describe('defineDevstack — plugin entrypoint expansion', () => {
	it('recursively includes plugin-valued dependencies before validation and runtime boot', () => {
		const database = definePlugin({
			id: 'test/database',
			kind: 'leaf-long-running',
			start: () => Effect.succeed({ url: 'postgres://devstack' } as const),
		});
		const api = definePlugin({
			id: 'test/api',
			dependsOn: { database },
			kind: 'leaf-long-running',
			start: (_ctx, { database }) => Effect.succeed({ upstream: database.url } as const),
		});

		const stack = defineDevstack({ members: [api] });
		expect(readStackEngine(stack).members.map((member) => member.provides.id)).toEqual([
			'test/database',
			'test/api',
		]);
	});

	it('dedupes repeated dependency refs in consumes without changing callback dependency shape', () => {
		const upstream = definePlugin({
			id: 'test/repeated-upstream',
			kind: 'leaf-long-running',
			start: () => Effect.succeed({ ok: true } as const),
		});
		const consumer = definePlugin({
			id: 'test/repeated-consumer',
			dependsOn: { first: upstream, second: upstream },
			kind: 'leaf-long-running',
			start: (_ctx, deps) => Effect.succeed(deps),
		});

		expect(consumer.dependsOn).toHaveLength(2);
		expect(consumer.consumes.map((tag) => tag.id)).toEqual(['test/repeated-upstream']);
	});

	it('throws on duplicate providers discovered through recursive dependencies', () => {
		const first = definePlugin({
			id: 'test/duplicate-provider',
			kind: 'leaf-long-running',
			start: () => Effect.succeed({ from: 'first' } as const),
		});
		const second = definePlugin({
			id: 'test/duplicate-provider',
			kind: 'leaf-long-running',
			start: () => Effect.succeed({ from: 'second' } as const),
		});
		const consumer = definePlugin({
			id: 'test/duplicate-consumer',
			dependsOn: [first, second],
			kind: 'leaf-long-running',
			start: () => Effect.succeed({ ok: true } as const),
		});

		expect(() => defineDevstack({ members: [consumer] })).toThrow(
			/Duplicate devstack provider for test\/duplicate-provider/,
		);
	});

	it('throws on circular plugin-valued dependency expansion', () => {
		const depsForA = [] as ReturnType<typeof resource>[];
		const a = definePlugin({
			id: 'test/cycle-a',
			dependsOn: depsForA,
			kind: 'leaf-long-running',
			start: () => Effect.succeed({ ok: 'a' } as const),
		});
		const b = definePlugin({
			id: 'test/cycle-b',
			dependsOn: [a],
			kind: 'leaf-long-running',
			start: () => Effect.succeed({ ok: 'b' } as const),
		});
		depsForA.push(b);

		expect(() => defineDevstack({ members: [a as never] })).toThrow(
			/Circular devstack dependency through test\/cycle-a/,
		);
	});

	it('does not expose current-engine members on the public stack handle', () => {
		const stack = defineDevstack({ members: [standalone] });

		expect(Object.hasOwn(stack, 'members')).toBe(false);
		// @ts-expect-error public Stack handles do not expose the engine member tuple
		void stack.members;
		expect(readStackEngine(stack).members).toHaveLength(1);
	});
});

if (false) {
	const bareCache = resource<'test/bare-cache', { readonly url: string }>('test/bare-cache');
	const needsBareCache = definePlugin({
		id: 'test/needs-bare-cache',
		dependsOn: bareCache,
		kind: 'leaf-long-running',
		start: (_ctx, cache) => Effect.succeed(cache),
	});
	// @ts-expect-error missing provider: test/bare-cache
	defineDevstack({ members: [needsBareCache] });
}

// --- Type-level pins ----------------------------------------------------
//
// These are compile-only: they have no `expect(...)` body, but the
// surrounding declarations must typecheck under `pnpm typecheck`.

describe('defineDevstack — D1 type-level pins', () => {
	it('compiles `defineDevstack(account("alice"))` without `MissingProviders<"sui">`', () => {
		// Bare member — would surface __MissingProvidersError<"sui"> if
		// auto-mount did not project the sui member into the
		// validation tuple.
		const alice = account('alice');
		const stack = defineDevstack({ members: [alice] });
		// The phantom `_providedIds` should witness 'sui' in the union.
		// We can't read the phantom at runtime, but the type narrowing
		// is verified by tsc; this test exists to anchor the
		// type-system invariant in the suite.
		expect(stack).toBeDefined();
	});

	it('compiles `defineDevstack(sui(), account("alice"))` (explicit sui, no double-mount)', () => {
		const alice = account('alice');
		const stack = defineDevstack({ members: [sui(), alice] });
		expect(readStackEngine(stack).members).toHaveLength(2);
	});
});
