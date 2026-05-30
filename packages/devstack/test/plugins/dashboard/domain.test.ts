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
import type { Identity } from '../../../src/substrate/identity.ts';
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
		identity: { app: 'demo', stack: 'main', chain: 'localnet' } as unknown as Identity,
		containerRuntime: null,
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
		identity: { app: 'demo', stack: 'main', chain: 'localnet' } as unknown as Identity,
		containerRuntime: null,
		strategyRegistry: args.registry,
	});

const SUI_TYPE = '0x2::sui::SUI';
const WAL_TYPE = '0xwal::wal::WAL';
const suiNode = (chain: string): ControlPlaneResolvedValue => ({
	pluginKey: 'sui',
	id: 'sui',
	value: { mode: 'local', chain },
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
				[`coinType:${WAL_TYPE}`]: { usesAccountSigner: true, request: () => Effect.void },
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
				[`coinType:${WAL_TYPE}`]: { usesAccountSigner: true, request: () => Effect.void },
			}),
		});
		const result = await Effect.runPromise(
			domain.fundAccount({ recipient: RECIPIENT, coinType: WAL_TYPE, amountBaseUnits: '500' }),
		);
		expect(result.ok).toBe(false);
		expect(result.detail).toContain('not a resolved account');
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
