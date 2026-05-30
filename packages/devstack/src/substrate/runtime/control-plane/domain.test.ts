// Focused unit tests for the control-plane mint ACTION.
//
// Exercises the validation + dispatch surface of `buildControlPlaneDomain`'s
// `mintCoin` accessor without standing up a real supervisor: we hand it a
// minimal `graph` + `registry` whose `readResolvedSync` (`__resolved` map)
// returns a fake resolved coin value carrying a `mintFromCap` stub. This
// pins the never-failing contract (`E = never`) and the address / amount
// validation the dashboard relies on.

import { describe, expect, it } from 'vitest';
import { Effect } from 'effect';

import { buildControlPlaneDomain, type ControlPlaneDomainDeps } from './domain.ts';
import type { PluginKey } from '../../brand.ts';
import type { ResolvedGraph } from '../lifecycle/index.ts';
import type { PluginRegistry } from '../lifecycle/plugin-registry.ts';
import type { Identity } from '../../identity.ts';

const COIN_TYPE = '0xpkg::mock_usdc::MOCK_USDC';
const RECIPIENT = '0x' + 'a'.repeat(64);

/** Build a minimal deps bag whose registry resolves one `coin:` node to
 *  `coinValue`. `mintFromCap` is whatever the test injects (or absent). */
const makeDeps = (coinValue: unknown): ControlPlaneDomainDeps => {
	const key = 'coin:demo/mock_usdc' as PluginKey;
	const graph = {
		nodes: new Map([[key, { member: { id: 'coin:demo/mock_usdc' } }]]),
	} as unknown as ResolvedGraph;
	const registry = {
		__resolved: new Map<PluginKey, unknown>([[key, coinValue]]),
	} as unknown as PluginRegistry;
	return {
		graph,
		registry,
		identity: { app: 'demo', stack: 'main', chain: 'localnet' } as unknown as Identity,
		snapshotOrchestrator: null,
		containerRuntime: null,
		fileSystem: null,
		logStore: null,
		spanStore: null,
	};
};

describe('control-plane mintCoin action', () => {
	it('mints via the resolved coin value mintFromCap closure and returns the digest', async () => {
		const seen: Array<{ to: string; amount: bigint }> = [];
		const domain = buildControlPlaneDomain(
			makeDeps({
				fullCoinType: COIN_TYPE,
				mintFromCap: (opts: { to: string; amount: bigint }) => {
					seen.push(opts);
					return Effect.succeed({ digest: '0xDIGEST' });
				},
			}),
		);
		const result = await Effect.runPromise(
			domain.mintCoin({ coinType: COIN_TYPE, recipient: RECIPIENT, amountBaseUnits: '1000000' }),
		);
		expect(result.ok).toBe(true);
		expect(result.digest).toBe('0xDIGEST');
		expect(seen).toEqual([{ to: RECIPIENT, amount: 1000000n }]);
	});

	it('rejects a non-0x recipient without invoking the mint', async () => {
		let called = false;
		const domain = buildControlPlaneDomain(
			makeDeps({
				fullCoinType: COIN_TYPE,
				mintFromCap: () => {
					called = true;
					return Effect.succeed({ digest: 'x' });
				},
			}),
		);
		const result = await Effect.runPromise(
			domain.mintCoin({ coinType: COIN_TYPE, recipient: 'alice', amountBaseUnits: '5' }),
		);
		expect(result.ok).toBe(false);
		expect(result.digest).toBeNull();
		expect(result.detail).toContain('invalid recipient');
		expect(called).toBe(false);
	});

	it('rejects a non-positive / non-integer amount', async () => {
		const domain = buildControlPlaneDomain(
			makeDeps({ fullCoinType: COIN_TYPE, mintFromCap: () => Effect.succeed({ digest: 'x' }) }),
		);
		for (const bad of ['0', '-5', '1.5', 'abc', '']) {
			const result = await Effect.runPromise(
				domain.mintCoin({ coinType: COIN_TYPE, recipient: RECIPIENT, amountBaseUnits: bad }),
			);
			expect(result.ok).toBe(false);
			expect(result.detail).toContain('invalid amountBaseUnits');
		}
	});

	it('reports no resolved coin for an unknown coin type', async () => {
		const domain = buildControlPlaneDomain(
			makeDeps({ fullCoinType: COIN_TYPE, mintFromCap: () => Effect.succeed({ digest: 'x' }) }),
		);
		const result = await Effect.runPromise(
			domain.mintCoin({ coinType: '0xother::x::X', recipient: RECIPIENT, amountBaseUnits: '1' }),
		);
		expect(result.ok).toBe(false);
		expect(result.detail).toContain('no resolved coin');
	});

	it('reports cap-not-owned when the coin value lacks mintFromCap', async () => {
		const domain = buildControlPlaneDomain(makeDeps({ fullCoinType: COIN_TYPE }));
		const result = await Effect.runPromise(
			domain.mintCoin({ coinType: COIN_TYPE, recipient: RECIPIENT, amountBaseUnits: '1' }),
		);
		expect(result.ok).toBe(false);
		expect(result.detail).toContain('no in-process treasury cap signer');
	});

	it('degrades a failing mint to ok:false with the error message (never throws)', async () => {
		const domain = buildControlPlaneDomain(
			makeDeps({
				fullCoinType: COIN_TYPE,
				mintFromCap: () =>
					Effect.fail({ _tag: 'CoinError', message: 'mint_and_transfer reverted' }),
			}),
		);
		const result = await Effect.runPromise(
			domain.mintCoin({ coinType: COIN_TYPE, recipient: RECIPIENT, amountBaseUnits: '1' }),
		);
		expect(result.ok).toBe(false);
		expect(result.digest).toBeNull();
		expect(result.detail).toBe('mint_and_transfer reverted');
	});
});
