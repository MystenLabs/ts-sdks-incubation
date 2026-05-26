// Wallet plugin — `accounts: 'all'` composer expansion (D6).
//
// Pinned behaviors per api-surface-design §4 D6:
//
//   1. `wallet({ accounts: 'all' })` returns a placeholder plugin with
//      `dependsOn: [suiResource]` only — the wider `account/${string}` resource
//      would widen `MissingProviders` to the template literal (which
//      never reduces to a concrete `account/<name>`).
//   2. The placeholder carries the symbol-keyed expander hook the
//      composer reads at `defineDevstack(...)` time.
//   3. The composer rewrites the placeholder into a real wallet member
//      whose `dependsOn` includes every account-providing plugin in
//      the stack (`account/alice`, `account/bob`, ...). This is what
//      the dep-graph topological scheduler reads to order wallet
//      strictly after account funding.
//   4. The explicit-array form (`accounts: [alice, bob]`) still works
//      identically — no expander hook, no composer rewrite, no
//      observable diff vs. the pre-D6 behavior.
//   5. The composer is a no-op (zero allocation) when no wallet
//      placeholder is present.

import { Effect, Exit, Option } from 'effect';
import { describe, expect, it } from 'vitest';
import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem';

import { defineDevstack, readStackEngine } from '../../../src/api/define-devstack.ts';
import { account } from '../../../src/plugins/account/index.ts';
import type { AccountValue } from '../../../src/plugins/account/service.ts';
import { sui } from '../../../src/plugins/sui/index.ts';
import { WALLET_ACCOUNTS_ALL, wallet } from '../../../src/plugins/wallet/index.ts';
import { acquireWallet, type WalletAcquireContext } from '../../../src/plugins/wallet/service.ts';
import { PLUGIN_EXPANDER } from '../../../src/contracts/plugin-expander.ts';

const fakeAccount = {
	name: 'alice',
	address: '0xabc',
	scheme: 'ed25519',
	publicKey: new Uint8Array(),
	source: 'real',
	funding: { requested: [], applied: [] },
	signAndExecute: () => Effect.die('not reached'),
	withTransactionSigner: () => Effect.die('not reached'),
	signTransaction: () => Effect.die('not reached'),
	signPersonalMessage: () => Effect.die('not reached'),
} as unknown as AccountValue;

describe('wallet({ accounts: "all" }) — D6 composer expansion', () => {
	it('wallet() is shorthand for inferred nonempty accounts', () => {
		const explicitSui = sui();
		const alice = account('alice');
		const stack = defineDevstack({ members: [explicitSui, alice, wallet()] });

		const walletMember = readStackEngine(stack).members.find((m) => m.id === 'wallet')!;
		const dependencyIds = walletMember.dependsOn.map((c) => c.id);
		expect(dependencyIds).toEqual(['sui', 'account/alice']);
	});

	it('placeholder plugin returned by the factory has only [suiResource] in dependsOn', () => {
		const placeholder = wallet({ accounts: WALLET_ACCOUNTS_ALL });

		// Before composer expansion, the only declared dep edge is sui.
		// Any wider declaration (e.g. `account/${string}`) would widen
		// the stack-level MissingProviders check.
		expect(placeholder.dependsOn).toHaveLength(1);
		expect(placeholder.dependsOn[0]!.id).toBe('sui');
	});

	it('placeholder carries the symbol-keyed expander hook (runtime-only)', () => {
		const placeholder = wallet({ accounts: WALLET_ACCOUNTS_ALL });

		// Symbol-keyed slot — intentionally not surfaced in the
		// factory's declared return type (a typed slot would leak the
		// symbol's identity into the user's inferred Stack type and
		// trigger TS2742 at every example's default export). The slot
		// is read by the composer at compose time via `Symbol.for(...)`
		// lookup; tests reach for it through the same untyped path.
		const slot = (placeholder as unknown as Record<symbol, unknown>)[PLUGIN_EXPANDER];
		expect(typeof slot).toBe('function');
	});

	it('composer rewrites the placeholder into a real wallet plugin whose dependencies fold in every account', () => {
		const alice = account('alice');
		const bob = account('bob');
		const carol = account('carol');

		const explicitSui = sui();
		const stack = defineDevstack({
			members: [explicitSui, alice, bob, carol, wallet({ accounts: WALLET_ACCOUNTS_ALL })],
		});

		// Locate the wallet member in the post-composer member tuple.
		const walletMember = readStackEngine(stack).members.find((m) => m.id === 'wallet');
		expect(walletMember).toBeDefined();

		// The expanded dependencies are [suiResource, account/alice, account/bob, account/carol].
		const dependencyIds = walletMember!.dependsOn.map((c) => c.id);
		expect(dependencyIds).toContain('sui');
		expect(dependencyIds).toContain('account/alice');
		expect(dependencyIds).toContain('account/bob');
		expect(dependencyIds).toContain('account/carol');
		expect(dependencyIds).toHaveLength(4);
	});

	it('composer-expanded wallet member no longer carries the expander hook', () => {
		const explicitSui = sui();
		const alice = account('alice');
		const stack = defineDevstack({
			members: [explicitSui, alice, wallet({ accounts: WALLET_ACCOUNTS_ALL })],
		});

		const walletMember = readStackEngine(stack).members.find((m) => m.id === 'wallet');
		expect(walletMember).toBeDefined();
		// The expander hook lives on the placeholder, NOT the rewritten
		// member. The composer's replacement is a fresh member via
		// `makeWalletMember(opts, accountMembers)` — the hook is
		// intentionally absent so a re-entered composer pass would be a
		// no-op rather than a re-expansion.
		const slot = (walletMember as unknown as Record<symbol, unknown>)[PLUGIN_EXPANDER];
		expect(slot).toBeUndefined();
	});

	it('respects the explicit sui provider when expanding', () => {
		// Explicit sui first, then D6 expands wallet. Wallet's dependencies
		// must still reference the shared `sui` resource.
		const explicitSui = sui();
		const alice = account('alice');
		const stack = defineDevstack({
			members: [explicitSui, alice, wallet({ accounts: WALLET_ACCOUNTS_ALL })],
		});

		expect(readStackEngine(stack).members[0]).toBe(explicitSui);
		const walletMember = readStackEngine(stack).members.find((m) => m.id === 'wallet')!;
		const dependencyIds = walletMember.dependsOn.map((c) => c.id);
		expect(dependencyIds).toContain('sui');
		expect(dependencyIds).toContain('account/alice');
	});

	it('empty all still composes to the placeholder dependency shape', () => {
		const explicitSui = sui();
		const stack = defineDevstack({
			members: [explicitSui, wallet({ accounts: WALLET_ACCOUNTS_ALL })],
		});

		const walletMember = readStackEngine(stack).members.find((m) => m.id === 'wallet')!;
		expect(walletMember.dependsOn).toHaveLength(1);
		expect(walletMember.dependsOn[0]!.id).toBe('sui');
	});

	it('empty resolved accounts fail at acquire with a typed wallet boot error', async () => {
		const ctx: WalletAcquireContext = {
			app: 'app',
			stack: 'main',
			chain: 'chain',
			stateRoot: '/tmp/devstack-wallet-empty',
			vitePortForThisStack: null,
			allocatePort: () => Effect.die('empty wallet should fail before allocating a port'),
			resolveAccounts: () => Effect.succeed([]),
			routerFrontedUrl: null,
			routedAppOrigin: null,
			supervisorCtx: undefined,
		};

		const exit = await Effect.runPromiseExit(
			Effect.scoped(acquireWallet({ accounts: WALLET_ACCOUNTS_ALL }, ctx)).pipe(
				Effect.provide(NodeFileSystem.layer),
			),
		);
		expect(Exit.isFailure(exit)).toBe(true);
		const err = Exit.findErrorOption(exit);
		expect(Option.isSome(err)).toBe(true);
		if (Option.isSome(err)) {
			expect(err.value._tag).toBe('WalletBootError');
			expect(err.value.phase).toBe('no-accounts');
			expect(err.value.message).toContain('zero accounts');
		}
	});

	it('defaults to a container-reachable bind address for routed stacks', async () => {
		const stateRoot = `/tmp/devstack-wallet-bind-${Date.now()}`;
		let allocation: { readonly preferred?: number; readonly probeHost?: string } | null = null;
		const ctx: WalletAcquireContext = {
			app: 'app',
			stack: 'main',
			chain: 'chain',
			stateRoot,
			vitePortForThisStack: null,
			allocatePort: (preferred, probeHost) => {
				allocation = { preferred, probeHost };
				return Effect.succeed(0);
			},
			resolveAccounts: () => Effect.succeed([fakeAccount]),
			routerFrontedUrl: 'http://api.app.localhost:6173',
			routedAppOrigin: null,
			supervisorCtx: undefined,
		};

		const value = await Effect.runPromise(
			Effect.scoped(acquireWallet({ accounts: WALLET_ACCOUNTS_ALL }, ctx)).pipe(
				Effect.provide(NodeFileSystem.layer),
			),
		);

		expect(allocation).toEqual({ preferred: undefined, probeHost: '0.0.0.0' });
		expect(value.server.url).toBe('http://0.0.0.0:0');
		expect(value.url).toBe('http://api.app.localhost:6173');
	});

	it('keeps direct fallback URLs loopback-readable when binding all interfaces', async () => {
		const stateRoot = `/tmp/devstack-wallet-direct-${Date.now()}`;
		const ctx: WalletAcquireContext = {
			app: 'app',
			stack: 'main',
			chain: 'chain',
			stateRoot,
			vitePortForThisStack: null,
			allocatePort: () => Effect.succeed(0),
			resolveAccounts: () => Effect.succeed([fakeAccount]),
			routerFrontedUrl: null,
			routedAppOrigin: null,
			supervisorCtx: undefined,
		};

		const value = await Effect.runPromise(
			Effect.scoped(acquireWallet({ accounts: WALLET_ACCOUNTS_ALL }, ctx)).pipe(
				Effect.provide(NodeFileSystem.layer),
			),
		);

		expect(value.url).toBe('http://127.0.0.1:0');
	});
});

describe('wallet({ accounts: [...] }) — explicit-array form (regression)', () => {
	it('explicit-array form still declares per-account dependencies at factory time', () => {
		const alice = account('alice');
		const bob = account('bob');

		const w = wallet({ accounts: [alice, bob] });

		// The factory itself populates dependencies — no composer rewrite
		// needed.
		const dependencyIds = w.dependsOn.map((c) => c.id);
		expect(dependencyIds).toEqual(['sui', 'account/alice', 'account/bob']);

		// No expander hook on the explicit-form member.
		const slot = (w as unknown as Record<symbol, unknown>)[PLUGIN_EXPANDER];
		expect(slot).toBeUndefined();
	});

	it('explicit-array form survives the composer untouched', () => {
		const alice = account('alice');
		const bob = account('bob');
		const w = wallet({ accounts: [alice, bob] });

		const explicitSui = sui();
		const stack = defineDevstack({ members: [explicitSui, alice, bob, w] });

		// The composer returns the same member reference (no rewrite).
		const walletMember = readStackEngine(stack).members.find((m) => m.id === 'wallet')!;
		expect(walletMember).toBe(w);
	});
});

describe('composer expansion — no-op without a placeholder', () => {
	it('zero allocation when no wallet placeholder is in the tuple', () => {
		const alice = account('alice');
		const bob = account('bob');

		const explicitSui = sui();
		const stack = defineDevstack({ members: [explicitSui, alice, bob] });

		// Each input member is preserved by identity.
		expect(readStackEngine(stack).members[1]).toBe(alice);
		expect(readStackEngine(stack).members[2]).toBe(bob);
	});
});
