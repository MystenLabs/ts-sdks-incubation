// Wallet plugin — `accounts: 'all'` composer expansion (D6).
//
// Pinned behaviors per api-surface-design §4 D6:
//
//   1. `wallet({ accounts: 'all' })` returns a placeholder member with
//      `consumes: [SuiTag]` only — the wider `account/${string}` tag
//      would widen `MissingProviders` to the template literal (which
//      never reduces to a concrete `account/<name>`).
//   2. The placeholder carries the symbol-keyed expander hook the
//      composer reads at `defineDevstack(...)` time.
//   3. The composer rewrites the placeholder into a real wallet member
//      whose `consumes` includes every account-providing member in
//      the stack (`account/alice`, `account/bob`, ...). This is what
//      the dep-graph topological scheduler reads to order wallet
//      strictly after account funding.
//   4. The explicit-array form (`accounts: [alice, bob]`) still works
//      identically — no expander hook, no composer rewrite, no
//      observable diff vs. the pre-D6 behavior.
//   5. The composer is a no-op (zero allocation) when no wallet
//      placeholder is present.

import { describe, expect, it } from 'vitest';

import { defineDevstack } from '../../../src/api/define-devstack.ts';
import { account } from '../../../src/plugins/account/index.ts';
import { sui } from '../../../src/plugins/sui/index.ts';
import {
	WALLET_ACCOUNTS_ALL,
	WALLET_EXPAND_ACCOUNTS_ALL,
	wallet,
} from '../../../src/plugins/wallet/index.ts';

describe('wallet({ accounts: "all" }) — D6 composer expansion', () => {
	it('placeholder member returned by the factory has only [SuiTag] in consumes', () => {
		const placeholder = wallet({ accounts: WALLET_ACCOUNTS_ALL });

		// Before composer expansion, the only declared dep edge is sui.
		// Any wider declaration (e.g. `account/${string}`) would widen
		// the stack-level MissingProviders check.
		expect(placeholder.consumes).toHaveLength(1);
		expect(placeholder.consumes[0]!.id).toBe('sui');
	});

	it('placeholder carries the symbol-keyed expander hook (runtime-only)', () => {
		const placeholder = wallet({ accounts: WALLET_ACCOUNTS_ALL });

		// Symbol-keyed slot — intentionally not surfaced in the
		// factory's declared return type (a typed slot would leak the
		// symbol's identity into the user's inferred Stack type and
		// trigger TS2742 at every example's default export). The slot
		// is read by the composer at compose time via `Symbol.for(...)`
		// lookup; tests reach for it through the same untyped path.
		const slot = (placeholder as unknown as Record<symbol, unknown>)[WALLET_EXPAND_ACCOUNTS_ALL];
		expect(typeof slot).toBe('function');
	});

	it('composer rewrites the placeholder into a real wallet member whose consumes fold in every account', () => {
		const alice = account('alice');
		const bob = account('bob');
		const carol = account('carol');

		const stack = defineDevstack(alice, bob, carol, wallet({ accounts: WALLET_ACCOUNTS_ALL }));

		// Locate the wallet member in the post-composer member tuple.
		const walletMember = stack.members.find((m) => m.provides.id === 'wallet');
		expect(walletMember).toBeDefined();

		// The expanded consumes is [SuiTag, account/alice, account/bob, account/carol].
		const consumesIds = walletMember!.consumes.map((c) => c.id);
		expect(consumesIds).toContain('sui');
		expect(consumesIds).toContain('account/alice');
		expect(consumesIds).toContain('account/bob');
		expect(consumesIds).toContain('account/carol');
		expect(consumesIds).toHaveLength(4);
	});

	it('composer-expanded wallet member no longer carries the expander hook', () => {
		const alice = account('alice');
		const stack = defineDevstack(alice, wallet({ accounts: WALLET_ACCOUNTS_ALL }));

		const walletMember = stack.members.find((m) => m.provides.id === 'wallet');
		expect(walletMember).toBeDefined();
		// The expander hook lives on the placeholder, NOT the rewritten
		// member. The composer's replacement is a fresh member via
		// `makeWalletMember(opts, accountMembers)` — the hook is
		// intentionally absent so a re-entered composer pass would be a
		// no-op rather than a re-expansion.
		const slot = (walletMember as unknown as Record<symbol, unknown>)[WALLET_EXPAND_ACCOUNTS_ALL];
		expect(slot).toBeUndefined();
	});

	it('respects auto-mounted sui when expanding (D1 + D6 compose)', () => {
		// No explicit sui — D1 prepends `sui()`, then D6 expands wallet.
		// Wallet's consumes must reference the auto-mounted sui too.
		const alice = account('alice');
		const stack = defineDevstack(alice, wallet({ accounts: WALLET_ACCOUNTS_ALL }));

		expect(stack.members[0]!.provides.id).toBe('sui');
		const walletMember = stack.members.find((m) => m.provides.id === 'wallet')!;
		const consumesIds = walletMember.consumes.map((c) => c.id);
		expect(consumesIds).toContain('sui');
		expect(consumesIds).toContain('account/alice');
	});

	it('zero accounts in the stack produces an empty per-account fold (only [SuiTag])', () => {
		// Edge case: user composes wallet({accounts:'all'}) into a stack
		// with no account members. The composer expands against an
		// empty account set — wallet's `consumes` becomes `[SuiTag]`
		// alone, identical to the placeholder. This is the "empty
		// wallet" shape (not generally useful, but the runtime should
		// not crash on it).
		const explicitSui = sui();
		const stack = defineDevstack(explicitSui, wallet({ accounts: WALLET_ACCOUNTS_ALL }));

		const walletMember = stack.members.find((m) => m.provides.id === 'wallet')!;
		expect(walletMember.consumes).toHaveLength(1);
		expect(walletMember.consumes[0]!.id).toBe('sui');
	});
});

describe('wallet({ accounts: [...] }) — explicit-array form (regression)', () => {
	it('explicit-array form still declares per-account consumes at factory time', () => {
		const alice = account('alice');
		const bob = account('bob');

		const w = wallet({ accounts: [alice, bob] });

		// The factory itself populates consumes — no composer rewrite
		// needed.
		const consumesIds = w.consumes.map((c) => c.id);
		expect(consumesIds).toEqual(['sui', 'account/alice', 'account/bob']);

		// No expander hook on the explicit-form member.
		const slot = (w as unknown as Record<symbol, unknown>)[WALLET_EXPAND_ACCOUNTS_ALL];
		expect(slot).toBeUndefined();
	});

	it('explicit-array form survives the composer untouched', () => {
		const alice = account('alice');
		const bob = account('bob');
		const w = wallet({ accounts: [alice, bob] });

		const stack = defineDevstack(alice, bob, w);

		// The composer returns the same member reference (no rewrite).
		const walletMember = stack.members.find((m) => m.provides.id === 'wallet')!;
		expect(walletMember).toBe(w);
	});
});

describe('composer expansion — no-op without a placeholder', () => {
	it('zero allocation when no wallet placeholder is in the tuple', () => {
		const alice = account('alice');
		const bob = account('bob');

		const stack = defineDevstack(alice, bob);

		// Each input member is preserved by identity (auto-mounted sui
		// is prepended; the user-supplied members keep their refs).
		expect(stack.members[1]).toBe(alice);
		expect(stack.members[2]).toBe(bob);
	});
});
