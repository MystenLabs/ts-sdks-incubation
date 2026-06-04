// Coin plugin — main acquire body.
//
// One-shot value resolution: the three address forms unify behind a
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
//   - Consume the LocalPackagePublishOutput — that's the discovery-fold path
//     handled at compose-time in the barrel (the barrel calls into
//     `discovery.ts` + `metadata.ts` to populate the registry as
//     packages publish; this file just READS the registry).
//   - Wire capabilities — the barrel's job.

import { Effect, type Scope } from 'effect';

import type {
	ArtifactPublishError,
	ArtifactPublisher,
} from '../../primitives/artifact-publisher.ts';
import {
	BUILTIN_COINS,
	resolveBuiltin,
	resolveByBareType,
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
 *  three address forms. */
export type CoinAddressForm =
	| {
			readonly kind: 'witness';
			readonly publishingPackageName: string;
			readonly witness: string;
			readonly fundingSigner?: MintSigner;
	  }
	| { readonly kind: 'known'; readonly fullCoinType: string }
	| { readonly kind: 'builtin'; readonly name: keyof typeof BUILTIN_COINS };

/** Per-acquire context supplied by the barrel from the BuildContext.
 *  Carries the resolved per-stack registry, the Sui-side SDK shim
 *  (verify probe + tx build), the chain id, and the
 *  `ArtifactPublisher` substrate primitive used by `performMint`. */
export interface CoinAcquireContext {
	readonly registry: CoinRegistry;
	readonly sdk: MetadataSdkShim & MintSdkShim;
	readonly chain: string;
	readonly publisher: ArtifactPublisher;
}

/** The tag's resolved value — the three address forms unified PLUS a
 *  closure for the generic mint surface. */
export interface CoinValue extends ResolvedCoin {
	/** Generic mint. Requires the cap id (either resolved from the
	 *  registry record's `treasuryCapId`, or supplied explicitly for
	 *  bare-type coins). Each call yields a fresh artifact publisher round (cache
	 *  hit means short-circuit per the substrate primitive). */
	readonly mint: (
		signer: MintSigner,
		opts: { readonly to: string; readonly amount: bigint; readonly treasuryCapId?: string },
	) => Effect.Effect<MintResult, CoinError | ArtifactPublishError, Scope.Scope>;
	/** Self-contained mint that needs NO external signer — present
	 *  exactly when `fundingStrategy` is (witness-form coins whose
	 *  publisher still owns the TreasuryCap). Captures the publisher
	 *  `MintSigner` + the resolved `treasuryCapId` internally and returns
	 *  the full `MintResult` (digest + minted-coin id), unlike
	 *  `fundingStrategy.request` which discards the result.
	 *
	 *  This is the seam the control-plane dashboard mint ACTION drives:
	 *  the supervisor reads the resolved `CoinValue` and calls this with
	 *  `{to, amount}` — no signer threading needed, because the
	 *  treasury-cap-owning publisher signer is already in-process here
	 *  (the same lease-owning path `fundingStrategy` uses). The Effect is
	 *  self-scoping (wraps `Effect.scoped` over the artifact-publisher
	 *  round), so callers run it directly without a surrounding Scope. */
	readonly mintFromCap?: (opts: {
		readonly to: string;
		readonly amount: bigint;
	}) => Effect.Effect<MintResult, CoinError | ArtifactPublishError>;
	/** Centralized funding strategy, present for local package coins
	 *  whose publisher still owns the TreasuryCap. The coin barrel
	 *  publishes it under `coinType:<fullCoinType>` so Account funding
	 *  can mint arbitrary local coins without bespoke example actions.
	 *
	 *  The request shape is a NARROWED projection of
	 *  `AccountFundingRequest` (`{address, amount}` only — the coin
	 *  strategy doesn't need the resolved account handle since the
	 *  TreasuryCap-owning publisher signs the mint via its own lease
	 *  inside `mint → signAndDispatch`). Direct consumers (deepbook
	 *  seed funding) call `.request({address, amount})` against this
	 *  narrowed shape; the coin barrel projects the value to the wider
	 *  `AccountFundingStrategy` cross-plugin contract at the
	 *  `strategy-contributor` capability boundary (see
	 *  `coin/index.ts → coinContributions`), wrapping the narrow
	 *  request fn so the account bus's `{address, amount, account}`
	 *  shape is satisfied honestly at the boundary.
	 *
	 *  The E channel preserves the tagged vocabulary
	 *  (`CoinError | ArtifactPublishError`) rather than collapsing to
	 *  `unknown`, so direct consumers can catchTag on the typed
	 *  errors. The account-side dispatcher's registry lookup narrows
	 *  the channel to `unknown` at the registry boundary and reads
	 *  `_tag` defensively. */
	readonly fundingStrategy?: {
		readonly request: (req: {
			readonly address: string;
			readonly amount: bigint;
		}) => Effect.Effect<void, CoinError | ArtifactPublishError>;
	};
}

/** Resolve a coin instance to the tag's resolved value. */
export const acquireCoin = (
	form: CoinAddressForm,
	ctx: CoinAcquireContext,
): Effect.Effect<CoinValue, CoinError> =>
	Effect.gen(function* () {
		const resolved: ResolvedCoin = yield* (() => {
			switch (form.kind) {
				case 'witness':
					return resolveByWitness(ctx.registry, form.publishingPackageName, form.witness);
				case 'known':
					return resolveByBareType(ctx.sdk, form.fullCoinType);
				case 'builtin':
					return Effect.succeed(resolveBuiltin(form.name));
			}
		})();

		const mint: CoinValue['mint'] = (signer, opts) => {
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
		};
		const fundingSigner = form.kind === 'witness' ? form.fundingSigner : undefined;
		const fundingTreasuryCapId = resolved.treasuryCapId;
		// Self-contained mint closure — same capture as `fundingStrategy`
		// (publisher signer + resolved cap) but returns the full
		// `MintResult` and self-scopes. Drives the dashboard mint action.
		const mintFromCap: CoinValue['mintFromCap'] =
			fundingSigner !== undefined && fundingTreasuryCapId !== undefined
				? (opts) =>
						Effect.scoped(
							mint(fundingSigner, {
								to: opts.to,
								amount: opts.amount,
								treasuryCapId: fundingTreasuryCapId,
							}),
						)
				: undefined;
		const fundingStrategy: CoinValue['fundingStrategy'] =
			fundingSigner !== undefined && fundingTreasuryCapId !== undefined
				? {
						request: (req) =>
							Effect.scoped(
								mint(fundingSigner, {
									to: req.address,
									amount: req.amount,
									treasuryCapId: fundingTreasuryCapId,
								}).pipe(Effect.asVoid),
							),
					}
				: undefined;
		const value: CoinValue = {
			...resolved,
			mint,
			...(mintFromCap === undefined ? {} : { mintFromCap }),
			...(fundingStrategy === undefined ? {} : { fundingStrategy }),
		};
		return value;
	});
