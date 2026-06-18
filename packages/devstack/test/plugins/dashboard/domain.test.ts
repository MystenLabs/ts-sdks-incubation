// Focused unit tests for the dashboard plugin-domain mint ACTION.
//
// Exercises the validation + dispatch surface of `buildDashboardDomain`'s
// `mintCoin` accessor without standing up a real supervisor: we hand it a
// stub `ControlPlaneDomain` whose generic `resolvedValues` seam returns a
// fake resolved coin value carrying a `mintFromCap` stub. This pins the
// never-failing contract (`E = never`) and the address / amount validation
// the dashboard relies on.
//
// (Relocated from substrate `control-plane/domain.test.ts` when the
// plugin-name-aware shaping moved out of the name-blind substrate seam into
// the dashboard plugin per ARCHITECTURE.md §"Substrate name-blindness".)

import { describe, expect, it } from 'vitest';
import { Effect } from 'effect';

import {
	buildDashboardDomain,
	type DashboardDomain,
} from '../../../src/plugins/dashboard/domain.ts';
import { emptyControlPlaneDomain } from '../../../src/substrate/runtime/control-plane/domain.ts';
import type {
	ControlPlaneDomain,
	ControlPlaneResolvedValue,
} from '../../../src/substrate/runtime/control-plane/service.ts';
import { StrategyNotFoundError } from '../../../src/substrate/runtime/errors.ts';
import type { StrategyRegistry } from '../../../src/contracts/strategy-contributor.ts';

const COIN_TYPE = '0xpkg::mock_usdc::MOCK_USDC';
const RECIPIENT = '0x' + 'a'.repeat(64);

/** Build a dashboard domain whose control plane resolves one `coin:` node
 *  to `coinValue`. `mintFromCap` is whatever the test injects (or absent). */
const makeDomain = (coinValue: unknown): DashboardDomain => {
	const control: ControlPlaneDomain = {
		...emptyControlPlaneDomain,
		resolvedValues: Effect.succeed([
			{ pluginKey: 'coin:demo/mock_usdc', id: 'coin:demo/mock_usdc', value: coinValue },
		]),
	};
	return buildDashboardDomain({
		control,
		strategyRegistry: null,
	});
};

/** A stub strategy registry over a fixed key→strategy map (and a `list` of
 *  the keys). `get` mirrors the real registry's `StrategyNotFoundError`. */
const makeStubRegistry = (entries: Record<string, unknown>): StrategyRegistry => ({
	get: <K extends string, S>(key: K) =>
		key in entries
			? Effect.succeed(entries[key] as S)
			: Effect.fail(
					new StrategyNotFoundError({ capabilityKey: key, registeredKeys: Object.keys(entries) }),
				),
	list: () => Effect.succeed(Object.keys(entries)),
	register: () => Effect.void as ReturnType<StrategyRegistry['register']>,
});

/** Build a dashboard domain with explicit resolved values + a stub registry
 *  for exercising the fund ACTION. */
const makeFundDomain = (args: {
	readonly resolved: ReadonlyArray<ControlPlaneResolvedValue>;
	readonly registry: StrategyRegistry | null;
}): DashboardDomain =>
	buildDashboardDomain({
		control: { ...emptyControlPlaneDomain, resolvedValues: Effect.succeed(args.resolved) },
		strategyRegistry: args.registry,
	});

const SUI_TYPE = '0x2::sui::SUI';
const WAL_TYPE = '0xwal::wal::WAL';
const suiNode = (chainId: string): ControlPlaneResolvedValue => ({
	pluginKey: 'sui',
	id: 'sui',
	value: { mode: 'local', chainId },
});
const accountNode = (name: string, address: string): ControlPlaneResolvedValue => ({
	pluginKey: `account:${name}`,
	id: `account/${name}`,
	value: { name, address },
});

describe('dashboard mintCoin action', () => {
	it('mints via the resolved coin value mintFromCap closure and returns the digest', async () => {
		const seen: Array<{ to: string; amount: bigint }> = [];
		const domain = makeDomain({
			fullCoinType: COIN_TYPE,
			mintFromCap: (opts: { to: string; amount: bigint }) => {
				seen.push(opts);
				return Effect.succeed({ digest: '0xDIGEST' });
			},
		});
		const result = await Effect.runPromise(
			domain.mintCoin({ coinType: COIN_TYPE, recipient: RECIPIENT, amountBaseUnits: '1000000' }),
		);
		expect(result.ok).toBe(true);
		expect(result.digest).toBe('0xDIGEST');
		expect(seen).toEqual([{ to: RECIPIENT, amount: 1000000n }]);
	});

	it('rejects a non-0x recipient without invoking the mint', async () => {
		let called = false;
		const domain = makeDomain({
			fullCoinType: COIN_TYPE,
			mintFromCap: () => {
				called = true;
				return Effect.succeed({ digest: 'x' });
			},
		});
		const result = await Effect.runPromise(
			domain.mintCoin({ coinType: COIN_TYPE, recipient: 'alice', amountBaseUnits: '5' }),
		);
		expect(result.ok).toBe(false);
		expect(result.digest).toBeNull();
		expect(result.detail).toContain('invalid recipient');
		expect(called).toBe(false);
	});

	it('rejects a non-positive / non-integer amount', async () => {
		const domain = makeDomain({
			fullCoinType: COIN_TYPE,
			mintFromCap: () => Effect.succeed({ digest: 'x' }),
		});
		for (const bad of ['0', '-5', '1.5', 'abc', '']) {
			const result = await Effect.runPromise(
				domain.mintCoin({ coinType: COIN_TYPE, recipient: RECIPIENT, amountBaseUnits: bad }),
			);
			expect(result.ok).toBe(false);
			expect(result.detail).toContain('invalid amountBaseUnits');
		}
	});

	it('reports no resolved coin for an unknown coin type', async () => {
		const domain = makeDomain({
			fullCoinType: COIN_TYPE,
			mintFromCap: () => Effect.succeed({ digest: 'x' }),
		});
		const result = await Effect.runPromise(
			domain.mintCoin({ coinType: '0xother::x::X', recipient: RECIPIENT, amountBaseUnits: '1' }),
		);
		expect(result.ok).toBe(false);
		expect(result.detail).toContain('no resolved coin');
	});

	it('reports cap-not-owned when the coin value lacks mintFromCap', async () => {
		const domain = makeDomain({ fullCoinType: COIN_TYPE });
		const result = await Effect.runPromise(
			domain.mintCoin({ coinType: COIN_TYPE, recipient: RECIPIENT, amountBaseUnits: '1' }),
		);
		expect(result.ok).toBe(false);
		expect(result.detail).toContain('no in-process treasury cap signer');
	});

	it('degrades a failing mint to ok:false with the error message (never throws)', async () => {
		const domain = makeDomain({
			fullCoinType: COIN_TYPE,
			mintFromCap: () => Effect.fail({ _tag: 'CoinError', message: 'mint_and_transfer reverted' }),
		});
		const result = await Effect.runPromise(
			domain.mintCoin({ coinType: COIN_TYPE, recipient: RECIPIENT, amountBaseUnits: '1' }),
		);
		expect(result.ok).toBe(false);
		expect(result.digest).toBeNull();
		expect(result.detail).toBe('mint_and_transfer reverted');
	});
});

describe('dashboard narrowing fail-loud (E2)', () => {
	/** A dashboard domain over arbitrary resolved values + no registry for
	 *  exercising structural narrowing. */
	const makeNarrowDomain = (resolved: ReadonlyArray<ControlPlaneResolvedValue>): DashboardDomain =>
		buildDashboardDomain({
			control: { ...emptyControlPlaneDomain, resolvedValues: Effect.succeed(resolved) },
			strategyRegistry: null,
		});

	it('deepbook mode=broken records a narrowingFault but still resolves (E=never)', async () => {
		const domain = makeNarrowDomain([
			{
				pluginKey: 'deepbook:demo',
				id: 'deepbook/demo',
				value: {
					mode: 'broken',
					network: 'localnet',
					packageId: '0xpkg',
					registryId: '0xreg',
					pools: [],
					hasSeedLiquidity: false,
				},
			},
		]);
		const [info] = await Effect.runPromise(domain.deepbook);
		expect(info).toBeDefined();
		// Safe display fallback so the panel renders…
		expect(info!.mode).toBe('local');
		// …while the drift is surfaced fail-loud.
		expect(info!.narrowingFault).toContain('deepbook.mode');
		expect(info!.narrowingFault).toContain('broken');
	});

	it('coin missing fullCoinType records a narrowingFault but still resolves', async () => {
		const domain = makeNarrowDomain([
			{
				pluginKey: 'coin:demo/x',
				id: 'coin:demo/x',
				value: { symbol: 'X', source: 'registry', decimals: 6 },
			},
		]);
		const [cap] = await Effect.runPromise(domain.coinCaps);
		expect(cap).toBeDefined();
		expect(cap!.fullCoinType).toBe('');
		expect(cap!.narrowingFault).toContain('coin.fullCoinType');
		expect(cap!.narrowingFault).toContain('missing');
	});

	it('mintCoin names the real cause when a candidate coin lacks fullCoinType (no throw)', async () => {
		const domain = makeNarrowDomain([
			// A coin node whose resolved value is missing fullCoinType entirely.
			{ pluginKey: 'coin:demo/x', id: 'coin:demo/x', value: { symbol: 'X' } },
		]);
		const result = await Effect.runPromise(
			domain.mintCoin({ coinType: COIN_TYPE, recipient: RECIPIENT, amountBaseUnits: '1' }),
		);
		expect(result.ok).toBe(false);
		expect(result.digest).toBeNull();
		expect(result.detail).toContain('coin.fullCoinType');
	});

	it('seal mode=bogus records a narrowingFault but still resolves', async () => {
		const domain = makeNarrowDomain([
			{
				pluginKey: 'seal:demo',
				id: 'seal:demo',
				value: { mode: 'bogus', objectId: '0xobj', keyServerUrl: 'http://seal', serverConfigs: [] },
			},
		]);
		const [info] = await Effect.runPromise(domain.seal);
		expect(info).toBeDefined();
		expect(info!.mode).toBe('local-keygen');
		expect(info!.narrowingFault).toContain('seal.mode');
	});

	it('a well-formed deepbook value records NO narrowingFault', async () => {
		const domain = makeNarrowDomain([
			{
				pluginKey: 'deepbook:demo',
				id: 'deepbook/demo',
				value: {
					mode: 'known',
					network: 'localnet',
					packageId: '0xpkg',
					registryId: '0xreg',
					pools: [],
					hasSeedLiquidity: false,
				},
			},
		]);
		const [info] = await Effect.runPromise(domain.deepbook);
		expect(info!.mode).toBe('known');
		expect(info!.narrowingFault).toBeNull();
	});

	it('surfaces seeded Pyth feeds + hasSeedLiquidity off the resolved value', async () => {
		const domain = makeNarrowDomain([
			{
				pluginKey: 'deepbook:demo',
				id: 'deepbook/demo',
				value: {
					mode: 'local',
					network: 'localnet',
					packageId: '0xpkg',
					registryId: '0xreg',
					pools: [],
					hasSeedLiquidity: true,
					pyth: {
						packageId: '0xpyth',
						stateId: null,
						wormholeStateId: null,
						// `price` arrives as a bigint on the resolved value — coerced to string.
						feeds: [{ symbol: 'SUI', priceInfoObjectId: '0xfeed', price: 123n, expo: -8 }],
					},
				},
			},
		]);
		const [info] = await Effect.runPromise(domain.deepbook);
		expect(info!.hasSeedLiquidity).toBe(true);
		expect(info!.pythFeeds).toEqual([
			{ symbol: 'SUI', priceInfoObjectId: '0xfeed', price: '123', expo: -8 },
		]);
		expect(info!.narrowingFault).toBeNull();
	});
});

describe('dashboard fundableCoins', () => {
	it('is empty when no strategy registry is wired', async () => {
		const domain = makeFundDomain({ resolved: [suiNode('sui:localnet')], registry: null });
		expect(await Effect.runPromise(domain.fundableCoins)).toEqual([]);
	});

	it('lists SUI (fixed-amount) when a faucet strategy is registered for the chain', async () => {
		const domain = makeFundDomain({
			resolved: [suiNode('sui:localnet')],
			registry: makeStubRegistry({ 'faucet:request:sui:localnet': { request: () => Effect.void } }),
		});
		const coins = await Effect.runPromise(domain.fundableCoins);
		expect(coins).toContainEqual({
			symbol: 'SUI',
			coinType: SUI_TYPE,
			honorsAmount: false,
			requiresAccountSigner: false,
		});
	});

	it('lists WAL (amount-honoring, account-signed) when a coinType strategy is registered', async () => {
		const domain = makeFundDomain({
			resolved: [suiNode('sui:localnet')],
			registry: makeStubRegistry({
				'faucet:request:sui:localnet': { request: () => Effect.void },
				[`coinType:${WAL_TYPE}`]: {
					usesAccountSigner: true,
					requiresRecipientAccount: true,
					request: () => Effect.void,
				},
			}),
		});
		const coins = await Effect.runPromise(domain.fundableCoins);
		expect(coins).toContainEqual({
			symbol: 'WAL',
			coinType: WAL_TYPE,
			honorsAmount: true,
			requiresAccountSigner: true,
		});
	});

	it('lists a managed coin as NOT account-signed (mint transfers to a passive recipient)', async () => {
		// The coin plugin auto-mounts a `coinType:` mint strategy that sets
		// usesAccountSigner (publisher self-lease) but NOT requiresRecipientAccount
		// — it mints to any address, so it must not demand a resolved account.
		const MANAGED = '0xmanaged::token::TOKEN';
		const domain = makeFundDomain({
			resolved: [suiNode('sui:localnet')],
			registry: makeStubRegistry({
				[`coinType:${MANAGED}`]: { usesAccountSigner: true, request: () => Effect.void },
			}),
		});
		const coins = await Effect.runPromise(domain.fundableCoins);
		expect(coins).toContainEqual({
			symbol: 'TOKEN',
			coinType: MANAGED,
			honorsAmount: true,
			requiresAccountSigner: false,
		});
	});
});

describe('dashboard fundAccount action', () => {
	it('requests SUI via the chain faucet strategy (fixed amount, any 0x address)', async () => {
		const seen: Array<{ address: string; amount: bigint }> = [];
		const domain = makeFundDomain({
			resolved: [suiNode('sui:localnet')],
			registry: makeStubRegistry({
				'faucet:request:sui:localnet': {
					request: (req: { address: string; amount: bigint }) => {
						seen.push(req);
						return Effect.void;
					},
				},
			}),
		});
		const result = await Effect.runPromise(domain.fundAccount({ recipient: RECIPIENT }));
		expect(result.ok).toBe(true);
		expect(seen).toHaveLength(1);
		expect(seen[0]!.address).toBe(RECIPIENT);
	});

	it('rejects a non-0x recipient', async () => {
		const domain = makeFundDomain({
			resolved: [suiNode('sui:localnet')],
			registry: makeStubRegistry({ 'faucet:request:sui:localnet': { request: () => Effect.void } }),
		});
		const result = await Effect.runPromise(domain.fundAccount({ recipient: 'alice' }));
		expect(result.ok).toBe(false);
		expect(result.detail).toContain('invalid recipient');
	});

	it('reports a missing SUI faucet strategy', async () => {
		const domain = makeFundDomain({
			resolved: [suiNode('sui:localnet')],
			registry: makeStubRegistry({}),
		});
		const result = await Effect.runPromise(domain.fundAccount({ recipient: RECIPIENT }));
		expect(result.ok).toBe(false);
		expect(result.detail).toContain('no SUI faucet strategy');
	});

	it('funds WAL through the coin strategy with the resolved account handle', async () => {
		const seen: Array<{ address: string; amount: bigint; account: { name: unknown } }> = [];
		const domain = makeFundDomain({
			resolved: [suiNode('sui:localnet'), accountNode('alice', RECIPIENT)],
			registry: makeStubRegistry({
				[`coinType:${WAL_TYPE}`]: {
					usesAccountSigner: true,
					requiresRecipientAccount: true,
					request: (req: { address: string; amount: bigint; account: { name: unknown } }) => {
						seen.push(req);
						return Effect.void;
					},
				},
			}),
		});
		const result = await Effect.runPromise(
			domain.fundAccount({ recipient: RECIPIENT, coinType: WAL_TYPE, amountBaseUnits: '500' }),
		);
		expect(result.ok).toBe(true);
		expect(seen).toHaveLength(1);
		expect(seen[0]!.amount).toBe(500n);
		expect(seen[0]!.account.name).toBe('alice');
	});

	it('rejects WAL funding to an address that is not a resolved account', async () => {
		const domain = makeFundDomain({
			resolved: [suiNode('sui:localnet')],
			registry: makeStubRegistry({
				[`coinType:${WAL_TYPE}`]: {
					usesAccountSigner: true,
					requiresRecipientAccount: true,
					request: () => Effect.void,
				},
			}),
		});
		const result = await Effect.runPromise(
			domain.fundAccount({ recipient: RECIPIENT, coinType: WAL_TYPE, amountBaseUnits: '500' }),
		);
		expect(result.ok).toBe(false);
		expect(result.detail).toContain('not a resolved account');
	});

	it('funds a managed coin to a passive 0x recipient that is NOT a stack account', async () => {
		// A managed-coin mint strategy (no requiresRecipientAccount) mints to any
		// address — it must NOT be rejected for a pasted recipient, and the
		// request runs without an account handle.
		const MANAGED = '0xmanaged::token::TOKEN';
		const seen: Array<{ address: string; amount: bigint; account?: unknown }> = [];
		const domain = makeFundDomain({
			resolved: [suiNode('sui:localnet')],
			registry: makeStubRegistry({
				[`coinType:${MANAGED}`]: {
					usesAccountSigner: true,
					request: (req: { address: string; amount: bigint; account?: unknown }) => {
						seen.push(req);
						return Effect.void;
					},
				},
			}),
		});
		const result = await Effect.runPromise(
			domain.fundAccount({ recipient: RECIPIENT, coinType: MANAGED, amountBaseUnits: '750' }),
		);
		expect(result.ok).toBe(true);
		expect(seen).toHaveLength(1);
		expect(seen[0]!.amount).toBe(750n);
		expect(seen[0]!.account).toBeUndefined();
	});

	it('rejects WAL funding with a non-positive amount', async () => {
		const domain = makeFundDomain({
			resolved: [suiNode('sui:localnet'), accountNode('alice', RECIPIENT)],
			registry: makeStubRegistry({
				[`coinType:${WAL_TYPE}`]: { usesAccountSigner: true, request: () => Effect.void },
			}),
		});
		const result = await Effect.runPromise(
			domain.fundAccount({ recipient: RECIPIENT, coinType: WAL_TYPE, amountBaseUnits: '0' }),
		);
		expect(result.ok).toBe(false);
		expect(result.detail).toContain('invalid amountBaseUnits');
	});

	it('degrades a failing WAL swap to ok:false (never throws)', async () => {
		const domain = makeFundDomain({
			resolved: [suiNode('sui:localnet'), accountNode('alice', RECIPIENT)],
			registry: makeStubRegistry({
				[`coinType:${WAL_TYPE}`]: {
					usesAccountSigner: true,
					request: () => Effect.fail({ _tag: 'WalrusPluginError', message: 'exchange empty' }),
				},
			}),
		});
		const result = await Effect.runPromise(
			domain.fundAccount({ recipient: RECIPIENT, coinType: WAL_TYPE, amountBaseUnits: '500' }),
		);
		expect(result.ok).toBe(false);
		expect(result.detail).toContain('exchange empty');
	});
});
