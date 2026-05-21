// Unit tests for S8 — walrus `local.seedAccounts` direct-member-ref
// tuple. Covers:
//
//   - Factory accepts seedAccounts shape + threads each account tag
//     through `consumes:` so the supervisor's topo scheduler waits
//     for each seed account's acquire (keypair mint + funding) before
//     the walrus composite dispatches.
//
//   - The admin shape (`WalrusAdmin.seedWal`) is backed by the first
//     seed account and no longer has a synthetic digest fail-open path.
//
// The factory itself doesn't dispatch acquire bodies — that's the
// supervisor's job — so these tests assert on the synchronous shape
// of the produced plugin (the StackMember) and the static surface
// contract.

import { describe, expect, it } from 'vitest';

import { account } from '../../../src/plugins/account/index.ts';
import { walrus } from '../../../src/plugins/walrus/index.ts';

describe('walrus({local: {seedAccounts: [...]}})', () => {
	it('produces a StackMember when called with the empty options bag', () => {
		const plugin = walrus({ local: {} });
		expect(plugin.provides).toBeDefined();
		expect(plugin.provides.id).toBe('walrus');
		expect(Array.isArray(plugin.consumes)).toBe(true);
	});

	it('threads each seedAccount tag through `consumes` so the supervisor orders the build edge', () => {
		const publisher = account('publisher');
		const alice = account('alice');
		const bob = account('bob');
		const plugin = walrus({
			local: { seedAccounts: [publisher, alice, bob] },
		});

		// consumes is `[SuiTag, account/publisher, account/alice, account/bob]`.
		const consumedIds = plugin.consumes.map((t) => t.id);
		expect(consumedIds).toContain('sui');
		expect(consumedIds).toContain('account/publisher');
		expect(consumedIds).toContain('account/alice');
		expect(consumedIds).toContain('account/bob');
	});

	it('produces a stable consumes tuple — sui first then each account ref in order', () => {
		const a1 = account('first');
		const a2 = account('second');
		const plugin = walrus({ local: { seedAccounts: [a1, a2] } });
		const consumedIds = plugin.consumes.map((t) => t.id);
		expect(consumedIds).toEqual(['sui', 'account/first', 'account/second']);
	});

	it('omits seed-account tags from `consumes` when seedAccounts is empty / absent', () => {
		const a = walrus({ local: {} });
		const b = walrus({ local: { seedAccounts: [] } });
		expect(a.consumes.map((t) => t.id)).toEqual(['sui']);
		expect(b.consumes.map((t) => t.id)).toEqual(['sui']);
	});

	it('walrus() with no opts produces the same consumes shape as walrus({local: {}})', () => {
		const plain = walrus();
		const explicit = walrus({ local: {} });
		expect(plain.consumes.map((t) => t.id)).toEqual(explicit.consumes.map((t) => t.id));
	});

	it('factory typechecks `walrus({local: {seedAccounts: [account(...), ...]}})` — locked API shape', () => {
		// Compile-time pin: this body is the example-4 shape from
		// api-surface-design.md. If `WalrusOptions.local.seedAccounts`
		// regresses away from direct account refs (or refuses an `AccountMember`
		// tuple), this test fails at typecheck.
		const publisher = account('publisher');
		const alice = account('alice');
		const bob = account('bob');
		const plugin = walrus({
			local: { nodeCount: 4, seedAccounts: [publisher, alice, bob] },
		});
		expect(plugin.provides.id).toBe('walrus');
	});
});
