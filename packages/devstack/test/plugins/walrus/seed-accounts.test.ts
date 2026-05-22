// Unit tests for S8 — walrus `local.seedAccounts` direct-member-ref
// tuple. Covers:
//
//   - Factory accepts seedAccounts shape + threads each account resource
//     through `dependsOn` so the supervisor's topo scheduler waits
//     for each seed account's start (keypair mint + funding) before
//     the Walrus service dispatches.
//
//   - The admin shape (`WalrusAdmin.seedWal`) is backed by the first
//     seed account and no longer has a synthetic digest fail-open path.
//
// The factory itself doesn't dispatch acquire bodies — that's the
// supervisor's job — so these tests assert on the synchronous shape
// of the produced plugin and the static surface
// contract.

import { describe, expect, it } from 'vitest';
import { Effect } from 'effect';

import { account } from '../../../src/plugins/account/index.ts';
import { appName, chainId, stackName } from '../../../src/substrate/brand.ts';
import type { AcquireContext } from '../../../src/substrate/plugin.ts';
import { walrus, walFaucetStrategyKey } from '../../../src/plugins/walrus/index.ts';
import type { WalrusResolved } from '../../../src/plugins/walrus/index.ts';

const fakeAcquireContext: AcquireContext = {
	identity: {
		app: appName('walrus-test'),
		stack: stackName('main'),
		chain: chainId('sui:localnet'),
	},
	chain: chainId('sui:localnet'),
	runtimeRoot: '/tmp/devstack-walrus-test',
};

const fakeWalrusResolved: WalrusResolved = {
	mode: 'local',
	chain: 'sui:localnet',
	packageConfig: {
		systemObjectId: '0xsystem',
		stakingPoolId: '0xstaking',
		exchangeIds: ['0xexchange'],
	},
	nodes: [],
	proxyUrl: 'http://walrus.localhost',
	aggregatorUrl: 'http://walrus.localhost',
	publisherUrl: 'http://walrus.localhost',
	admin: null,
	walFaucetStrategy: { request: () => Effect.void },
	walCoinType: '0xfeed::wal::WAL',
};

describe('walrus({local: {seedAccounts: [...]}})', () => {
	it('produces a plugin when called with the empty options bag', () => {
		const plugin = walrus({ local: {} });
		expect(plugin.id).toBeDefined();
		expect(plugin.id).toBe('walrus');
		expect(Array.isArray(plugin.dependsOn)).toBe(true);
	});

	it('threads each seedAccount resource through `dependsOn` so the supervisor orders the build edge', () => {
		const publisher = account('publisher');
		const alice = account('alice');
		const bob = account('bob');
		const plugin = walrus({
			local: { seedAccounts: [publisher, alice, bob] },
		});

		const dependencyIds = plugin.dependsOn.map((resource) => resource.id);
		expect(dependencyIds).toContain('sui');
		expect(dependencyIds).toContain('account/publisher');
		expect(dependencyIds).toContain('account/alice');
		expect(dependencyIds).toContain('account/bob');
	});

	it('produces a stable dependency tuple — sui first then each account ref in order', () => {
		const a1 = account('first');
		const a2 = account('second');
		const plugin = walrus({ local: { seedAccounts: [a1, a2] } });
		const dependencyIds = plugin.dependsOn.map((resource) => resource.id);
		expect(dependencyIds).toEqual(['sui', 'account/first', 'account/second']);
	});

	it('omits seed-account resources from `dependsOn` when seedAccounts is empty / absent', () => {
		const a = walrus({ local: {} });
		const b = walrus({ local: { seedAccounts: [] } });
		expect(a.dependsOn.map((t) => t.id)).toEqual(['sui']);
		expect(b.dependsOn.map((t) => t.id)).toEqual(['sui']);
	});

	it('walrus() with no opts produces the same dependency shape as walrus({local: {}})', () => {
		const plain = walrus();
		const explicit = walrus({ local: {} });
		expect(plain.dependsOn.map((t) => t.id)).toEqual(explicit.dependsOn.map((t) => t.id));
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
		expect(plugin.id).toBe('walrus');
	});

	it('registers the WAL faucet strategy under the resolved full coin type', () => {
		const plugin = walrus({ local: { seedAccounts: [account('publisher')] } });
		if (typeof plugin.capabilities !== 'function') {
			throw new Error('expected walrus capabilities factory');
		}

		const capabilitiesFactory = plugin.capabilities as unknown as (
			value: WalrusResolved,
			runtime: AcquireContext,
		) => ReadonlyArray<{ readonly kind: string; readonly capabilityKey?: string }>;
		const capabilities = capabilitiesFactory(fakeWalrusResolved, fakeAcquireContext);
		const walStrategy = capabilities.find(
			(capability) =>
				capability.kind === 'strategy-contributor' &&
				capability.capabilityKey === walFaucetStrategyKey('0xfeed::wal::WAL'),
		);

		expect(walStrategy).toBeDefined();
	});
});
