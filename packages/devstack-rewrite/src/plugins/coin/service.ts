// Coin plugin — main acquire body.
//
// One-shot value resolution: the four address forms unify behind a
// single `acquireCoin` Effect. The barrel (`index.ts`) constructs ONE
// `CoinAcquireInputs` per declared coin instance and routes here.
//
// What this file does:
//
//   1. Dispatch on the address-form discriminator to the right
//      resolver under `address-resolution.ts`.
//   2. Project the resolved value into the user-facing `ResolvedCoin`
//      shape that the Tag publishes.
//   3. Project a `mint(...)` closure (lazy mint — captures the
//      resolved fullCoinType + the cap id; defers the substrate-
//      primitive call to mint time so the cache key is keyed on
//      mint-time inputs, not factory-time ones).
//
// What it does NOT do:
//
//   - Consume the PublishReceipt — that's the discovery-fold path
//     handled at compose-time in the barrel (the barrel calls into
//     `discovery.ts` + `metadata.ts` to populate the registry as
//     packages publish; this file just READS the registry).
//   - Wire capabilities — the barrel's job.

import { Effect, type Scope } from 'effect';

import type { ChainId } from '../../substrate/brand.ts';
import type {
	OnChainArtifactError,
	OnChainArtifactPublisher,
} from '../../primitives/on-chain-artifact.ts';
import {
	BUILTIN_COINS,
	resolveBuiltin,
	resolveByBareType,
	resolveBySymbol,
	resolveByWitness,
	type ResolvedCoin,
} from './address-resolution.ts';
import { coinError, type CoinError } from './errors.ts';
import type { MetadataSdkShim } from './metadata.ts';
import {
	performMint,
	type MintInputs,
	type MintResult,
	type MintSdkShim,
	type MintSigner,
} from './mint.ts';
import type { CoinRegistry } from './registry.ts';

/** Per-instance options threaded into the acquire body. One-of the
 *  four address forms. */
export type CoinAddressForm =
	| { readonly kind: 'symbol'; readonly symbol: string }
	| {
			readonly kind: 'witness';
			readonly publishingPackageName: string;
			readonly witness: string;
	  }
	| { readonly kind: 'known'; readonly fullCoinType: string }
	| { readonly kind: 'builtin'; readonly name: keyof typeof BUILTIN_COINS };

/** Per-acquire context supplied by the barrel from the BuildContext.
 *  Carries the resolved per-stack registry, the Sui-side SDK shim
 *  (verify probe + tx build), the chain id, and the
 *  `OnChainArtifactPublisher` substrate primitive used by `performMint`. */
export interface CoinAcquireContext {
	readonly registry: CoinRegistry;
	readonly sdk: MetadataSdkShim & MintSdkShim;
	readonly chain: ChainId;
	readonly publisher: OnChainArtifactPublisher;
}

/** The tag's resolved value — the four address forms unified PLUS a
 *  closure for the generic mint surface. */
export interface CoinValue extends ResolvedCoin {
	/** Generic mint. Requires the cap id (either resolved from the
	 *  registry record's `treasuryCapId`, or supplied explicitly for
	 *  bare-type coins). Each call yields a fresh OCA round (cache
	 *  hit means short-circuit per the substrate primitive). */
	readonly mint: (
		signer: MintSigner,
		opts: { readonly to: string; readonly amount: bigint; readonly treasuryCapId?: string },
	) => Effect.Effect<MintResult, CoinError | OnChainArtifactError, Scope.Scope>;
}

/** Resolve a coin instance to the tag's resolved value. */
export const acquireCoin = (
	form: CoinAddressForm,
	ctx: CoinAcquireContext,
): Effect.Effect<CoinValue, CoinError> =>
	Effect.gen(function* () {
		yield* Effect.annotateCurrentSpan({
			'coin.form': form.kind,
		});

		const resolved: ResolvedCoin = yield* (() => {
			switch (form.kind) {
				case 'symbol':
					return resolveBySymbol(ctx.registry, form.symbol);
				case 'witness':
					return resolveByWitness(ctx.registry, form.publishingPackageName, form.witness);
				case 'known':
					return resolveByBareType(ctx.sdk, form.fullCoinType);
				case 'builtin':
					return Effect.succeed(resolveBuiltin(form.name));
			}
		})();

		yield* Effect.annotateCurrentSpan({
			'coin.fullCoinType': resolved.fullCoinType,
			'coin.decimals': resolved.decimals,
			'coin.source': resolved.source,
		});

		const value: CoinValue = {
			...resolved,
			mint: (signer, opts) => {
				const capId = opts.treasuryCapId ?? resolved.treasuryCapId;
				if (capId === undefined) {
					return Effect.fail(
						coinError('cap-missing', {
							identifier: resolved.fullCoinType,
							message: `coin('${resolved.fullCoinType}').mint(): no treasury cap available — pass opts.treasuryCapId or use a coin discovered with publisherOwnsCap=true.`,
						}),
					);
				}
				const inputs: MintInputs = {
					fullCoinType: resolved.fullCoinType,
					treasuryCapId: capId,
					recipient: opts.to,
					amount: opts.amount,
				};
				return performMint(ctx.publisher, ctx.chain, signer, ctx.sdk, inputs);
			},
		};
		return value;
	});
