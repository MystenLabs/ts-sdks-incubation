// Structural pins for the `NetworkResolver` capability contract.
//
// NetworkResolver is consulted ONCE per acquire; the answer threads as
// Context. Funds-ready is NOT engine-generic — it's a StrategyContributor
// capability key (`gate:funds-ready`). Pins:
//   1. `FUNDS_READY_GATE_KEY` is the literal `'gate:funds-ready'`,
//   2. `NetworkResolutionError._tag` + closed `reason` union,
//   3. `FundsReadyError._tag` shape,
//   4. `NetworkResolver.resolve` signature.

import { describe, expect, it } from 'vitest';
import { Effect } from 'effect';

import {
	FUNDS_READY_GATE_KEY,
	type FundsReadyError,
	type FundsReadyStrategy,
	type NetworkResolutionError,
	type NetworkResolver,
} from '../../src/contracts/network-resolver.ts';

describe('contracts/network-resolver — structural pins', () => {
	it('`FUNDS_READY_GATE_KEY` is the literal `"gate:funds-ready"`', () => {
		expect(FUNDS_READY_GATE_KEY).toBe('gate:funds-ready');
		const narrowed: 'gate:funds-ready' = FUNDS_READY_GATE_KEY;
		expect(narrowed).toBe('gate:funds-ready');
	});

	it('`NetworkResolutionError._tag` is the literal `"NetworkResolutionError"`', () => {
		const err: NetworkResolutionError = {
			_tag: 'NetworkResolutionError',
			reason: 'invalid-mode',
			detail: 'bad value',
		};
		const tag: 'NetworkResolutionError' = err._tag;
		expect(tag).toBe('NetworkResolutionError');
	});

	it('`NetworkResolutionError.reason` is the closed `invalid-mode | unknown-chain | rpc-unreachable` union', () => {
		const reasons: ReadonlyArray<NetworkResolutionError['reason']> = [
			'invalid-mode',
			'unknown-chain',
			'rpc-unreachable',
		];
		expect(reasons).toHaveLength(3);

		const _bad: NetworkResolutionError = {
			_tag: 'NetworkResolutionError',
			// @ts-expect-error -- `'misconfigured'` is not in the reason union.
			reason: 'misconfigured',
			detail: '',
		};
		void _bad;
	});

	it('`FundsReadyError._tag` is the literal `"FundsReadyError"`', () => {
		const err: FundsReadyError = {
			_tag: 'FundsReadyError',
			reason: 'faucet not reachable',
		};
		const tag: 'FundsReadyError' = err._tag;
		expect(tag).toBe('FundsReadyError');
	});

	it('`FundsReadyStrategy.waitFundsReady` returns `Effect.Effect<void, FundsReadyError>`', () => {
		const strategy: FundsReadyStrategy = { waitFundsReady: Effect.void };
		// Compile-time pin: the strategy is a value, not a function — the
		// architecture removed the previous "L0 exposes awaitFunds" wording.
		expect(strategy.waitFundsReady).toBeDefined();
	});

	it('`NetworkResolver.resolve` returns `Effect.Effect<NetworkConfig, NetworkResolutionError>`', () => {
		// We construct a non-functional resolver only to pin the structural
		// shape; runtime behavior is exercised in the integration tests.
		const resolver: NetworkResolver = {
			resolve: Effect.die('shape-only fixture'),
		};
		expect(resolver.resolve).toBeDefined();
	});

	it('rejects a literal that omits the `_tag` discriminator', () => {
		// @ts-expect-error -- `_tag` is required.
		const _bad: NetworkResolutionError = {
			reason: 'invalid-mode',
			detail: '',
		};
		void _bad;
	});
});
