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
import type { ControlPlaneDomain } from '../../../src/substrate/runtime/control-plane/service.ts';
import type { Identity } from '../../../src/substrate/identity.ts';

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
	});
};

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
