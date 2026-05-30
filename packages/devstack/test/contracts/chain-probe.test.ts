// Structural pins for the `ChainProbe` capability contract.
//
// ChainProbe is dispatched through the StrategyContributor registry by
// the `chain-probe:<chain>` capability-key shape — it is NOT a
// discriminated-union `kind`-tagged decl like the other contracts in this
// folder. This file pins:
//   1. the `chainProbeCapabilityKey(chain)` key constructor,
//   2. the `ChainProbeError` tagged shape (`_tag: 'ChainProbeError'`),
//   3. the structural `ChainProbe<Key>.get` signature,
//   4. the `ChainProbeMode` literal union.

import { describe, expect, it } from 'vitest';
import { Effect, Schema } from 'effect';

import { chainId } from '../../src/substrate/brand.ts';
import {
	chainProbeCapabilityKey,
	type ChainProbe,
	type ChainProbeError,
	type ChainProbeMode,
} from '../../src/contracts/chain-probe.ts';

describe('contracts/chain-probe — structural pins', () => {
	it('`chainProbeCapabilityKey(chain)` mints `chain-probe:<chain>`', () => {
		expect(chainProbeCapabilityKey(chainId('sui:testnet'))).toBe('chain-probe:sui:testnet');
		expect(chainProbeCapabilityKey(chainId('sui:local'))).toBe('chain-probe:sui:local');
	});

	it('`ChainProbeMode` is the closed `"lenient" | "strict"` union', () => {
		const lenient: ChainProbeMode = 'lenient';
		const strict: ChainProbeMode = 'strict';
		expect(lenient).toBe('lenient');
		expect(strict).toBe('strict');

		// @ts-expect-error -- only `'lenient' | 'strict'` allowed.
		const _bad: ChainProbeMode = 'best-effort';
		void _bad;
	});

	it('`ChainProbeError._tag` is the literal `"ChainProbeError"` with closed `reason` union', () => {
		const err: ChainProbeError = {
			_tag: 'ChainProbeError',
			reason: 'not-found',
			chain: 'sui:testnet',
			detail: 'missing object',
		};
		const tag: 'ChainProbeError' = err._tag;
		expect(tag).toBe('ChainProbeError');

		// Reason is closed: decode-failed | not-found | transient | no-probe-registered.
		const _bad: ChainProbeError = {
			_tag: 'ChainProbeError',
			// @ts-expect-error -- `'rate-limited'` is not in the reason union.
			reason: 'rate-limited',
			chain: 'sui:testnet',
			detail: '',
		};
		void _bad;
	});

	it('`ChainProbe<Key>.get` accepts a schema with `never`-context decoding services', () => {
		interface ObjectKey {
			readonly objectId: string;
		}
		const schema = Schema.Struct({ count: Schema.Number });

		const probe: ChainProbe<ObjectKey> = {
			get: <Shape>() => Effect.succeed(null as Shape | null),
		};

		expect(typeof probe.get).toBe('function');
		// Compile-time check: the get signature returns `Effect<Shape | null, ChainProbeError>`
		// for any Shape the caller pins via the schema.
		const result: Effect.Effect<{ count: number } | null, ChainProbeError> = probe.get(
			{ objectId: '0x1' },
			schema,
			'lenient',
		);
		void result;
	});
});
