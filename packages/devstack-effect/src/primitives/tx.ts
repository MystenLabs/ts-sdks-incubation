import { Effect, Option } from 'effect';
import { Transaction } from '@mysten/sui/transactions';
import { makeTag, setPhase, type PluginTag } from '../tag.js';
import { PublishError } from './errors.js';
import { StateStore } from '../internal/state-store.js';
import { Sui } from './sui.js';
import type { Account, TxResult } from './shared.js';

export interface TxOptions<Name extends string, R> {
	readonly name: Name;
	readonly signer: PluginTag<any, Account, any, any>;
	readonly gasBudget?: bigint;
	readonly build: (transaction: Transaction) => Effect.Effect<void, never, R>;
	readonly dependsOn?: ReadonlyArray<PluginTag<any, any, any, any>>;
	/**
	 * Optional cache key. When set, `tx` is treated as idempotent against
	 * this key folded with the chain id: if a prior execution's `TxResult`
	 * lives in the state store under the same key, it's returned without
	 * re-signing/executing. The cache key effect can `yield* parentTag` to
	 * fold parent state into the key — e.g. a tx that calls into a
	 * `publishMove` package should fold that package's `packageId` so the
	 * cache invalidates when the package republishes.
	 *
	 * Omit for tx that should fire every cycle (e.g. tx that mutates a
	 * known shared object — re-firing is the feature, not a bug). When
	 * set, the on-chain side effects of this tx are assumed to persist
	 * across `docker rm` (your `sui.localnet` should be on a named
	 * volume) — otherwise a stale cached result will reference objects
	 * the freshly-genesised chain no longer has.
	 *
	 * Example:
	 *   tx({
	 *     name: 'arena.openLobby',
	 *     signer: a.alice,
	 *     dependsOn: [connectFourPublish],
	 *     cacheKey: Effect.gen(function* () {
	 *       const pkg = yield* connectFourPublish;
	 *       return pkg.packageId;
	 *     }),
	 *     build: (t) => ...,
	 *   });
	 */
	readonly cacheKey?: Effect.Effect<string, unknown, unknown>;
}

export const tx = <const Name extends string, R = never>(options: TxOptions<Name, R>) =>
	makeTag(
		options.name,
		Effect.gen(function* () {
			for (const tag of options.dependsOn ?? []) {
				yield* tag;
			}
			const signer = yield* options.signer;

			// Cache-key path. Compute key first; on a hit, return the prior
			// TxResult and skip build + sign + execute entirely. Folding
			// `sui.chainId` into the key means a regenesis of the underlying
			// chain naturally misses the cache (the cached objectChanges
			// reference object ids that no longer exist).
			if (options.cacheKey !== undefined) {
				const sui = yield* Sui;
				const state = yield* StateStore;
				const userKey = yield* (options.cacheKey as Effect.Effect<string, unknown, never>);
				const fullKey = `tx/${options.name}/${sui.chainId}/${signer.address}/${userKey}`;
				const cached = yield* state.get<TxResult>(fullKey);
				if (Option.isSome(cached)) {
					yield* Effect.logInfo(
						`tx(${options.name}): cache hit — key=${userKey} digest=${cached.value.digest}`,
					);
					return cached.value;
				}
				yield* Effect.logInfo(
					`tx(${options.name}): cache miss — key=${userKey} (will sign+execute)`,
				);
				yield* setPhase('building');
				const t = new Transaction();
				if (options.gasBudget !== undefined) {
					t.setGasBudget(options.gasBudget);
				}
				yield* options.build(t);
				yield* setPhase('executing');
				const result = yield* signer.signAndExecute(t).pipe(
					Effect.mapError(
						(cause) =>
							new PublishError({
								stage: 'publish-tx',
								message: `tx(${options.name}): sign+execute failed`,
								cause,
							}),
					),
				);
				yield* state.put(fullKey, result);
				return result satisfies TxResult;
			}

			yield* setPhase('building');
			const t = new Transaction();
			if (options.gasBudget !== undefined) {
				t.setGasBudget(options.gasBudget);
			}
			yield* options.build(t);
			yield* setPhase('executing');
			const result = yield* signer.signAndExecute(t).pipe(
				Effect.mapError(
					(cause) =>
						new PublishError({
							stage: 'publish-tx',
							message: `tx(${options.name}): sign+execute failed`,
							cause,
						}),
				),
			);
			return result satisfies TxResult;
		}).pipe(Effect.withSpan(`tx(${options.name})`)),
		{
			kind: 'action',
			displayTitle: `tx.${options.name}`,
			display: (s) => ({
				title: `tx.${options.name}`,
				primary: `digest ${s.digest}`,
				...(s.objectChanges.length > 0
					? { extras: [`${s.objectChanges.length} object${s.objectChanges.length === 1 ? '' : 's'}`] }
					: {}),
			}),
		},
	);
