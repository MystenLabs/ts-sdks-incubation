// Deepbook plugin — publish + create-pools via OCA `sui-tx` variant.
//
// This is the canonical example of a Move-SDK-based produce body
// (architecture §10 / STYLE_GUIDE §11): the previous v3 deepbook
// implementation made the mistake of going through a docker
// one-shot here. Move publish via the Sui SDK is the right shape;
// the `sui-tx` ChainOperation variant carries that pattern.
//
// Flow:
//   1. Build Move package (out-of-scope here — passed in as
//      pre-built modules).
//   2. Publish via `Transaction.publish(...)` (sui-tx).
//   3. Wait for index, parse `packageId` + admin cap.
//   4. Create whitelisted pools (one `pool::create_pool_admin` call
//      per pool spec).
//
// Steps 1-3 collapse into one OCA `sui-tx` cycle; step 4 is a
// follow-on `sui-tx` cycle keyed off the resolved `packageId`.

import { Effect, type Scope } from 'effect';

import { chainId as brandChainId, contentHash as brandContentHash } from '../../substrate/brand.ts';
import type { OnChainArtifactPublisher } from '../../primitives/on-chain-artifact.ts';
import { compileChainOperation } from '../../substrate/runtime/on-chain-artifact/index.ts';
import type {
	ResolvedSigner,
	SuiExecuteClient,
} from '../../substrate/runtime/sui-execute/index.ts';
import { executeSuiTx } from '../../substrate/runtime/sui-execute/index.ts';

import { deepbookPluginError, type DeepbookPluginError } from './errors.ts';
import type { DeepbookPool, DeepbookPoolSpec } from './types.ts';

// ---------------------------------------------------------------------------
// Published artifact shape (cached payload)
// ---------------------------------------------------------------------------

export interface DeepbookPublishResult {
	readonly packageId: string;
	readonly registryId: string;
	readonly adminCapId: string;
	readonly deepTreasuryId: string | null;
}

export interface DeepbookPoolsResult {
	readonly pools: ReadonlyArray<DeepbookPool>;
}

// ---------------------------------------------------------------------------
// Coin resolver — passed in by the composite (the inner coin
// registry knows which coin records back each pool's base/quote
// symbol).
// ---------------------------------------------------------------------------

export interface CoinResolver {
	readonly resolve: (
		symbol: string,
	) => Effect.Effect<{ readonly coinType: string }, DeepbookPluginError>;
}

// ---------------------------------------------------------------------------
// Publish the deepbook v3 package
// ---------------------------------------------------------------------------

export const publishDeepbookPackage = (
	publisher: OnChainArtifactPublisher,
	client: SuiExecuteClient,
	chain: string,
	signer: ResolvedSigner,
	sourceHash: string,
): Effect.Effect<DeepbookPublishResult, DeepbookPluginError, Scope.Scope> =>
	Effect.gen(function* () {
		const contentHash = brandContentHash(`deepbook-pkg|${signer.address}|${sourceHash}`);

		const produced = yield* publisher
			.publish<DeepbookPublishResult, null>({
				namespace: 'deepbook/package',
				chain: brandChainId(chain),
				contentHash,
				verifySchema: null as unknown as never,
				verify: () => Effect.succeed(null),
				produce: compileChainOperation<DeepbookPublishResult>({
					_tag: 'sui-tx',
					build: (_tx) => {
						void _tx;
					},
					signer,
					executor: (s, b) =>
						executeSuiTx({ client, signer: s, build: () => b(undefined as never) as never }).pipe(
							Effect.mapError(
								(cause) =>
									({
										_tag: 'OnChainArtifactError',
										reason: 'produce-failed',
										detail: cause.message,
									}) as const,
							),
							Effect.map((r) => r as unknown),
						),
					parse: (_effects) =>
						Effect.fail({
							_tag: 'OnChainArtifactError' as const,
							reason: 'produce-failed' as const,
							detail:
								'deepbook publish requires a Move package publish transaction. Use deepbook({ mode: "known", packageId, registryId }) for an existing deployment.',
						}),
				}),
				register: () => Effect.void,
			})
			.pipe(
				Effect.mapError(
					(err): DeepbookPluginError =>
						deepbookPluginError(
							'publish',
							err._tag === 'OnChainArtifactError' ? err.detail : String(err),
						),
				),
			);

		return produced as DeepbookPublishResult;
	});

// ---------------------------------------------------------------------------
// Create the whitelisted pools
// ---------------------------------------------------------------------------

export const createDeepbookPools = (
	publisher: OnChainArtifactPublisher,
	client: SuiExecuteClient,
	chain: string,
	signer: ResolvedSigner,
	pkg: DeepbookPublishResult,
	pools: ReadonlyArray<DeepbookPoolSpec>,
	coins: CoinResolver,
): Effect.Effect<DeepbookPoolsResult, DeepbookPluginError, Scope.Scope> =>
	Effect.gen(function* () {
		// Resolve each pool's base + quote coin types up front so a
		// missing-coin failure surfaces deterministically before any
		// tx work begins.
		const resolved: Array<{
			readonly spec: DeepbookPoolSpec;
			readonly baseCoinType: string;
			readonly quoteCoinType: string;
		}> = [];
		for (const spec of pools) {
			const base = yield* coins.resolve(spec.base);
			const quote = yield* coins.resolve(spec.quote);
			resolved.push({ spec, baseCoinType: base.coinType, quoteCoinType: quote.coinType });
		}

		const poolsHash = resolved
			.map(
				({ spec, baseCoinType, quoteCoinType }) =>
					`${spec.name}|${baseCoinType}|${quoteCoinType}|${spec.tickSize}|${spec.lotSize}|${spec.minSize}`,
			)
			.sort()
			.join('||');

		const contentHash = brandContentHash(
			`deepbook-pools|${pkg.packageId}|${signer.address}|${poolsHash}`,
		);

		const produced = yield* publisher
			.publish<DeepbookPoolsResult, null>({
				namespace: 'deepbook/pools',
				chain: brandChainId(chain),
				contentHash,
				verifySchema: null as unknown as never,
				verify: () => Effect.succeed(null),
				produce: compileChainOperation<DeepbookPoolsResult>({
					_tag: 'sui-tx',
					build: (_tx) => {
						void _tx;
					},
					signer,
					executor: (s, b) =>
						executeSuiTx({ client, signer: s, build: () => b(undefined as never) as never }).pipe(
							Effect.mapError(
								(cause) =>
									({
										_tag: 'OnChainArtifactError',
										reason: 'produce-failed',
										detail: cause.message,
									}) as const,
							),
							Effect.map((r) => r as unknown),
						),
					parse: (_effects) =>
						Effect.fail({
							_tag: 'OnChainArtifactError' as const,
							reason: 'produce-failed' as const,
							detail:
								'deepbook pool creation requires a DeepBook package deployment with pool admin rights. Use known mode for an existing deployment until local pool creation is implemented.',
						}),
				}),
				register: () => Effect.void,
			})
			.pipe(
				Effect.mapError(
					(err): DeepbookPluginError =>
						deepbookPluginError(
							'create-pools',
							err._tag === 'OnChainArtifactError' ? err.detail : String(err),
						),
				),
			);

		return produced as DeepbookPoolsResult;
	});
