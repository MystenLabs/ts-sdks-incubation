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

import { defineDevstack } from '../../src/api/define-devstack.ts';
import { defineNodePlugin } from '../../src/api/define-plugin.ts';
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
		const stack = defineDevstack(alice);

		expect(stack.members).toHaveLength(2);
		expect(stack.members[0]!.provides.id).toBe('sui');
		expect(stack.members[1]!.provides.id).toBe('account/alice');
	});

	it('prepends sui() when a USER-AUTHORED plugin consumes SuiTag (plugin-author symmetry)', () => {
		const stack = defineDevstack(customNeedsSui);

		expect(stack.members).toHaveLength(2);
		expect(stack.members[0]!.provides.id).toBe('sui');
		expect(stack.members[1]!.provides.id).toBe('custom/needs-sui');
	});

	it('does NOT double-mount when the user supplies explicit sui()', () => {
		const explicit = sui();
		const alice = account('alice');
		const stack = defineDevstack(explicit, alice);

		expect(stack.members).toHaveLength(2);
		// The user's explicit sui is preserved — same reference, not a
		// fresh `sui()` injected by the composer.
		expect(stack.members[0]).toBe(explicit);
		expect(stack.members[1]).toBe(alice);
	});

	it('does NOT double-mount when the user supplies a non-default sui mode', () => {
		// Any sui mode satisfies the "provides 'sui'" predicate — the
		// auto-mount key is the tag id, not the mode. Exercise with
		// the external mode (a non-default opts shape) to pin that the
		// composer checks the tag id, not the call shape.
		const explicit = sui({ mode: 'live', network: 'testnet' });
		const alice = account('alice');
		const stack = defineDevstack(explicit, alice);

		expect(stack.members).toHaveLength(2);
		expect(stack.members[0]).toBe(explicit);
	});

	it('does NOT auto-mount when no member consumes sui (predicate is "needed AND missing")', () => {
		const stack = defineDevstack(standalone);

		expect(stack.members).toHaveLength(1);
		expect(stack.members[0]!.provides.id).toBe('leaf/standalone');
	});

	it('survives a trailing options bag with auto-mount in front', () => {
		const alice = account('alice');
		const stack = defineDevstack(alice, { stackName: 'd1-options-trail' });

		expect(stack.members).toHaveLength(2);
		expect(stack.members[0]!.provides.id).toBe('sui');
		expect(stack.options.stackName).toBe('d1-options-trail');
	});

	it('places the auto-mounted sui at index 0 so dep-graph topological order is stable', () => {
		const alice = account('alice');
		const bob = account('bob');
		const stack = defineDevstack(alice, bob);

		expect(stack.members[0]!.provides.id).toBe('sui');
		// User's relative order is preserved after the prepend.
		expect(stack.members[1]!.provides.id).toBe('account/alice');
		expect(stack.members[2]!.provides.id).toBe('account/bob');
	});
});

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
		const stack = defineDevstack(alice);
		// The phantom `_providedIds` should witness 'sui' in the union.
		// We can't read the phantom at runtime, but the type narrowing
		// is verified by tsc; this test exists to anchor the
		// type-system invariant in the suite.
		expect(stack).toBeDefined();
	});

	it('compiles `defineDevstack(sui(), account("alice"))` (explicit sui, no double-mount)', () => {
		const stack = defineDevstack(sui(), account('alice'));
		expect(stack.members).toHaveLength(2);
	});
});
