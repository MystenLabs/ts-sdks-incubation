// ChainProbe capability contract (architecture §9).
//
// Typed, schema-validated read surface over an on-chain RPC.
// Consumers never depend on raw SDK property access.
//
// Lenient mode returns absence for both not-found and transient RPC
// failure (so verify probes re-derive on the next cycle); strict
// throws on transient failure.

import type { Effect, Schema } from 'effect';

import type { ChainId } from '../substrate/brand.ts';

export type ChainProbeMode = 'lenient' | 'strict';

/** Capability-key constructor — chain-probes are dispatched through
 *  the StrategyContributor registry by this key shape. */
export const chainProbeCapabilityKey = (chain: ChainId): `chain-probe:${string}` =>
	`chain-probe:${chain}`;

/**
 * Plugin-typed read interface. `Key` is the chain's native id
 * shape (object id, tx digest); `Shape` is the expected decoded
 * shape.
 */
/** Schema-shape accepted by the probe. We constrain `DecodingServices`
 *  to `never` because the probe pipeline cannot inject services from
 *  the caller — schemas with dependencies are unsupported here. */
export type ChainProbeSchema<Shape> = Schema.Codec<Shape, unknown, never, never>;

export interface ChainProbe<Key> {
	readonly get: <Shape>(
		key: Key,
		schema: ChainProbeSchema<Shape>,
		mode: ChainProbeMode,
	) => Effect.Effect<Shape | null, ChainProbeError>;
	readonly batchGet?: <Shape>(
		keys: ReadonlyArray<Key>,
		schema: ChainProbeSchema<Shape>,
		mode: ChainProbeMode,
	) => Effect.Effect<ReadonlyArray<Shape | null>, ChainProbeError>;
}

export interface ChainProbeError {
	readonly _tag: 'ChainProbeError';
	readonly reason: 'decode-failed' | 'not-found' | 'transient' | 'no-probe-registered';
	readonly chain: string;
	readonly detail: string;
}
