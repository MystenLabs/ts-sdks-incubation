// `defineDevstack` — composer-level invariants.
//
// Pinned behaviors:
//
//   1. Sui is explicit: built-ins may depend on the abstract `sui`
//      resource, but a stack that needs Sui must list a concrete
//      `sui(...)` provider.
//   2. Specific Sui configs are selected once at the stack root; every
//      plugin depending on `suiResource` binds to that provider.
//   3. No-op when no member depends on Sui: a stack of pure leaves with
//      no Sui dependency stays Sui-free.
//   4. Plugin-author symmetry: a user-authored plugin can depend on a
//      Sui plugin value and have it recursively included.

import { Effect } from 'effect';
import { describe, expect, it } from 'vitest';

import { defineDevstack, readStackEngine } from '../../src/api/define-devstack.ts';
import { definePlugin, isPlugin, isResourceRef, resource } from '../../src/api/define-plugin.ts';
import { account } from '../../src/plugins/account/index.ts';
import { coin } from '../../src/plugins/coin/index.ts';
import { hostService } from '../../src/plugins/host-service/index.ts';
import { localPackage } from '../../src/plugins/package/index.ts';
import { sui } from '../../src/plugins/sui/index.ts';
import { wallet } from '../../src/plugins/wallet/index.ts';

// --- Fixtures -----------------------------------------------------------

/** A leaf with zero upstream — no Sui provider is needed when this is
 *  the only member. */
const standalone = definePlugin({
	id: 'leaf/standalone',
	role: 'service',
	section: 'service',
	start: () => Effect.succeed({ id: 1 } as const),
});

const localnet = sui({ mode: 'local-rpc', rpcUrl: 'http://127.0.0.1:9000' });
const bareSuiResource = resource<'sui', { readonly chain: string }>('sui');
const customNeedsSui = definePlugin({
	id: 'custom/needs-sui',
	dependsOn: { sui: localnet },
	role: 'service',
	section: 'service',
	start: ({ sui }) => Effect.succeed({ chain: sui.chainId } as const),
});
const customNeedsBareSui = definePlugin({
	id: 'custom/needs-bare-sui',
	dependsOn: { sui: bareSuiResource },
	role: 'service',
	section: 'service',
	start: ({ sui }) => Effect.succeed({ chain: sui.chain } as const),
});

// --- Explicit Sui provider ---------------------------------------------

describe('defineDevstack — explicit sui provider', () => {
	it('uses the explicit sui provider for built-in members that depend on Sui', () => {
		const explicit = sui();
		const alice = account('alice');
		const stack = defineDevstack({ members: [explicit, alice] });

		expect(readStackEngine(stack).members).toHaveLength(2);
		expect(readStackEngine(stack).members[0]).toBe(explicit);
		expect(readStackEngine(stack).members[1]).toBe(alice);
	});

	it('recursively includes a user-authored plugin dependency on a Sui plugin value', () => {
		const stack = defineDevstack({ members: [customNeedsSui] });

		expect(readStackEngine(stack).members).toHaveLength(2);
		expect(readStackEngine(stack).members[0]).toBe(localnet);
		expect(readStackEngine(stack).members[1]!.id).toBe('custom/needs-sui');
	});

	it('binds a bare sui resource dependency to the explicit stack provider', () => {
		const explicit = sui({ mode: 'live', network: 'testnet' });
		const stack = defineDevstack({ members: [explicit, customNeedsBareSui] });

		expect(readStackEngine(stack).members).toHaveLength(2);
		expect(readStackEngine(stack).members[0]).toBe(explicit);
		expect(readStackEngine(stack).members[1]!.id).toBe('custom/needs-bare-sui');
	});

	it('preserves a non-default sui mode without adding another provider', () => {
		const explicit = sui({ mode: 'live', network: 'testnet' });
		const alice = account('alice');
		const stack = defineDevstack({ members: [explicit, alice] });

		expect(readStackEngine(stack).members).toHaveLength(2);
		expect(readStackEngine(stack).members[0]).toBe(explicit);
	});

	it('does not require Sui when no member depends on Sui', () => {
		const stack = defineDevstack({ members: [standalone] });

		expect(readStackEngine(stack).members).toHaveLength(1);
		expect(readStackEngine(stack).members[0]!.id).toBe('leaf/standalone');
	});

	it('preserves options with explicit Sui in the member tuple', () => {
		const explicit = sui();
		const alice = account('alice');
		const stack = defineDevstack({ members: [explicit, alice], stackName: 'explicit-sui' });

		expect(readStackEngine(stack).members).toHaveLength(2);
		expect(readStackEngine(stack).members[0]).toBe(explicit);
		expect(stack.options.stackName).toBe('explicit-sui');
	});

	it('keeps user member order stable with explicit Sui first', () => {
		const explicit = sui();
		const alice = account('alice');
		const bob = account('bob');
		const stack = defineDevstack({ members: [explicit, alice, bob] });

		expect(readStackEngine(stack).members[0]).toBe(explicit);
		expect(readStackEngine(stack).members[1]!.id).toBe('account/alice');
		expect(readStackEngine(stack).members[2]!.id).toBe('account/bob');
	});
});

describe('defineDevstack — plugin entrypoint expansion', () => {
	it('treats sui() as a definePlugin resource ref', () => {
		const plugin = sui({ mode: 'local-rpc', rpcUrl: 'http://127.0.0.1:9000' });

		expect(isPlugin(plugin)).toBe(true);
		expect(isResourceRef(plugin)).toBe(true);
		expect(plugin.id).toBe('sui');
		expect(plugin.dependsOn).toEqual([]);
	});

	it('recursively includes plugin-valued dependencies before validation and runtime boot', () => {
		const database = definePlugin({
			id: 'test/database',
			role: 'service',
			section: 'service',
			start: () => Effect.succeed({ url: 'postgres://devstack' } as const),
		});
		const api = definePlugin({
			id: 'test/api',
			dependsOn: { database },
			role: 'service',
			section: 'service',
			start: ({ database }) => Effect.succeed({ upstream: database.url } as const),
		});

		const stack = defineDevstack({ members: [api] });
		expect(readStackEngine(stack).members.map((member) => member.id)).toEqual([
			'test/database',
			'test/api',
		]);
	});

	it('dedupes repeated dependency refs without changing callback dependency shape', () => {
		const upstream = definePlugin({
			id: 'test/repeated-upstream',
			role: 'service',
			section: 'service',
			start: () => Effect.succeed({ ok: true } as const),
		});
		const consumer = definePlugin({
			id: 'test/repeated-consumer',
			dependsOn: { first: upstream, second: upstream },
			role: 'service',
			section: 'service',
			start: (deps) => Effect.succeed(deps),
		});

		expect(consumer.dependsOn).toHaveLength(1);
		expect(consumer.dependsOn.map((resource) => resource.id)).toEqual(['test/repeated-upstream']);
	});

	it('stores dependency input under the global plugin metadata symbol', () => {
		const upstream = definePlugin({
			id: 'test/global-symbol-upstream',
			role: 'service',
			section: 'service',
			start: () => Effect.succeed({ ok: true } as const),
		});
		const consumer = definePlugin({
			id: 'test/global-symbol-consumer',
			dependsOn: [upstream],
			role: 'service',
			section: 'service',
			start: (deps) => Effect.succeed(deps),
		});

		expect(
			(consumer as unknown as Record<symbol, unknown>)[
				Symbol.for('devstack.plugin.dependency-input')
			],
		).toEqual([upstream]);
		expect((consumer as unknown as Record<symbol, unknown>)[Symbol.for('devstack.plugin')]).toBe(
			true,
		);
	});

	it('throws on duplicate providers discovered through recursive dependencies', () => {
		const first = definePlugin({
			id: 'test/duplicate-provider',
			role: 'service',
			section: 'service',
			start: () => Effect.succeed({ from: 'first' } as const),
		});
		const second = definePlugin({
			id: 'test/duplicate-provider',
			role: 'service',
			section: 'service',
			start: () => Effect.succeed({ from: 'second' } as const),
		});
		const consumer = definePlugin({
			id: 'test/duplicate-consumer',
			dependsOn: [first, second],
			role: 'service',
			section: 'service',
			start: () => Effect.succeed({ ok: true } as const),
		});

		expect(() => defineDevstack({ members: [consumer] })).toThrow(
			/Duplicate devstack provider for test\/duplicate-provider/,
		);
	});

	it('throws on account names that differ only by casing', () => {
		const alice = account('alice');
		const Alice = account('Alice');

		expect(() => defineDevstack({ members: [sui(), alice, Alice] })).toThrow(
			/Duplicate devstack account name 'Alice' differs only by casing from 'alice'/,
		);
	});

	it('throws on circular plugin-valued dependency expansion', () => {
		const depsForA = [] as ReturnType<typeof resource>[];
		const a = definePlugin({
			id: 'test/cycle-a',
			dependsOn: depsForA,
			role: 'service',
			section: 'service',
			start: () => Effect.succeed({ ok: 'a' } as const),
		});
		const b = definePlugin({
			id: 'test/cycle-b',
			dependsOn: [a],
			role: 'service',
			section: 'service',
			start: () => Effect.succeed({ ok: 'b' } as const),
		});
		depsForA.push(b);

		expect(() => defineDevstack({ members: [a as never] })).toThrow(
			/Circular devstack dependency through test\/cycle-a/,
		);
	});

	it("expands wallet({ accounts: 'all' }) after recursive dependency closure", () => {
		const alice = account('alice');
		const bob = account('bob');
		const accountSetup = definePlugin({
			id: 'test/account-setup',
			dependsOn: { alice, bob },
			role: 'task',
			section: 'service',
			start: () => Effect.succeed({ ok: true } as const),
		});
		const walletAll = wallet({ accounts: 'all' });
		const app = definePlugin({
			id: 'test/app-with-wallet-all',
			dependsOn: [accountSetup, walletAll] as const,
			role: 'service',
			section: 'service',
			start: () => Effect.succeed({ ok: true } as const),
		});

		const explicit = sui();
		const stack = defineDevstack({ members: [explicit, app] });

		expect(readStackEngine(stack).members.map((member) => member.id)).toEqual([
			'sui',
			'account/alice',
			'account/bob',
			'test/account-setup',
			'wallet',
			'test/app-with-wallet-all',
		]);
	});

	it('recursively includes explicit wallet account plugin dependencies', () => {
		const alice = account('alice');
		const bob = account('bob');

		const explicit = sui();
		const stack = defineDevstack({ members: [explicit, wallet({ accounts: [alice, bob] })] });

		expect(readStackEngine(stack).members.map((member) => member.id)).toEqual([
			'sui',
			'account/alice',
			'account/bob',
			'wallet',
		]);
	});

	it('preserves plugin-valued refs through built-in resource-ref option types', () => {
		const publisher = account('publisher');
		const demoPackage = localPackage('demo', {
			sourcePath: './move/demo',
			publisher,
		});
		const demoCoin = coin.fromPackage(demoPackage, 'DEMO');
		const app = hostService({
			name: 'app',
			command: 'pnpm',
			args: ['dev'],
			after: [demoCoin] as const,
		});

		const explicit = sui();
		const stack = defineDevstack({ members: [explicit, app] });

		expect(readStackEngine(stack).members.map((member) => member.id)).toEqual([
			'sui',
			'account/publisher',
			'package:demo',
			'coin:demo/demo',
			'host-service/app',
		]);
	});

	it('does not expose current-engine members on the public stack handle', () => {
		const stack = defineDevstack({ members: [standalone] });

		expect(Object.hasOwn(stack, 'members')).toBe(false);
		// @ts-expect-error public Stack handles do not expose the engine member tuple
		void stack.members;
		expect(readStackEngine(stack).members).toHaveLength(1);
	});
});

// oxlint-disable-next-line no-constant-condition
if (false) {
	const needsSui = account('needsSui');
	// @ts-expect-error missing provider: sui
	defineDevstack({ members: [needsSui] });

	// @ts-expect-error missing provider: sui
	defineDevstack({ members: [customNeedsBareSui] });

	const bareCache = resource<'test/bare-cache', { readonly url: string }>('test/bare-cache');
	const needsBareCache = definePlugin({
		id: 'test/needs-bare-cache',
		dependsOn: bareCache,
		role: 'service',
		section: 'service',
		start: (cache) => Effect.succeed(cache),
	});
	// @ts-expect-error missing provider: test/bare-cache
	defineDevstack({ members: [standalone, needsBareCache] });
}

// --- Type-level pins ----------------------------------------------------
//
// These are compile-only: they have no `expect(...)` body, but the
// surrounding declarations must typecheck under `pnpm typecheck`.

describe('defineDevstack — explicit Sui type-level pins', () => {
	it('compiles `defineDevstack(sui(), account("alice"))`', () => {
		const alice = account('alice');
		const stack = defineDevstack({ members: [sui(), alice] });
		expect(readStackEngine(stack).members).toHaveLength(2);
	});
});
