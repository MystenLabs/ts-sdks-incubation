// Action(name, opts) — post-publish setup tx. The build callback
// receives a raw `Transaction` builder; its return Effect's `E` channel
// widens to whatever the yielded LayeredTags propagate (e.g. `PublishError`
// from a `Package` ref), and the supervisor catches errors at the
// engine level so users don't have to `catchTag` inside every action.
//
// Phase C migration target — runs through `onChainArtifact(spec)` so the
// cache/verify/register discipline matches every other on-chain primitive
// (publishMove, deepbookLocalDeploy, walrus deploy, etc.). The user-
// facing positional surface `Action(name, opts)` is unchanged; the
// substrate underneath collapsed the bespoke `cacheKey` + `probeCachedTx`
// shape into the standard `(namespace, inputs, verify, produce, register)`
// shape.

import { Effect } from 'effect';
import { Transaction } from '@mysten/sui/transactions';
import { setPhase, type LayeredTag } from '../advanced/tag.js';
import { PublishError } from '../engine/errors.js';
import { onChainArtifact } from '../engine/on-chain-artifact.js';
import type { Account, TxResult } from '../engine/shared.js';

export interface ActionOptions<Name extends string, R, E = unknown> {
	/** Account that signs the action. */
	readonly signer: LayeredTag<any, Account, any, any>;
	/** Refs this action depends on. Yielded for ordering before `build`
	 *  runs. Typically a list of `Package` refs whose ids the action
	 *  references in `moveCall` targets. */
	readonly needs?: ReadonlyArray<LayeredTag<any, any, any, any>>;
	/** Optional gas budget for the transaction. */
	readonly gasBudget?: bigint;
	/** Build the transaction. Receives a fresh `Transaction` builder. The
	 *  return Effect's `E` channel widens to whatever the yielded LayeredTags
	 *  propagate; the supervisor catches errors at the engine level. */
	readonly build: (transaction: Transaction) => Effect.Effect<void, E, R>;
	/** Optional per-action discriminator folded into the cache key. Two
	 *  accepted forms:
	 *    - `Effect<string>` — full programmatic control. Yielded at
	 *      acquire time.
	 *    - `string` — literal key.
	 *
	 *  When omitted, the cache key still distinguishes per-action
	 *  instance via `(name, signer.address, needs[].key)` — i.e. two
	 *  distinct `Action(name, ...)` factories with the same name+signer
	 *  +needs collide intentionally. Set this when you have two actions
	 *  with the same identity but different desired cache slots
	 *  (e.g. seeding versioned game state). */
	readonly cacheKey?: Effect.Effect<string, unknown, unknown> | string;
	/** Reserved for the typed `_name` parameter; defaults to the action's
	 *  `name`. */
	readonly _name?: Name;
}

/** Action factory. Returns a LayeredTag that runs the supplied transaction
 *  through the `onChainArtifact` substrate: cache key folds in
 *  `sui.chainId` + the signer's address + every `needs[].key` + the
 *  optional `cacheKey`. On a hit the cached `TxResult` is verified via
 *  `ChainProbe.getTransaction(digest)` — if the digest no longer resolves
 *  (regenesis, snapshot mismatch) the entry evicts and the action
 *  re-fires.
 *
 *  Cache lifetime: persists across cycle teardown — chain state lives in
 *  the writable layer (preserved by `docker stop`, captured by
 *  `docker commit`), so cached results stay valid across `r` / Ctrl-C
 *  but NOT across `devstack stack down --force` or `wipe` (which discard
 *  the layer). A regenesis flips `sui.chainId` and naturally misses the
 *  cache.
 *
 *  Behaviour change vs the prior bespoke shape: every `Action(...)` is
 *  now cached. The previous "no cacheKey → run unconditionally every
 *  cycle" branch is gone — set `cacheKey: Effect.sync(() => uuid())` (or
 *  similar) at the call site if you need to force a re-fire on every
 *  cycle. In practice every observed call site is idempotent against the
 *  resolved package id; the change moves the implicit "I am idempotent"
 *  property into the typed cache-key shape. */
export const Action = <const Name extends string, R = never, E = unknown>(
	name: Name,
	opts: ActionOptions<Name, R, E>,
) => {
	const cacheKeyEff =
		opts.cacheKey === undefined
			? undefined
			: typeof opts.cacheKey === 'string'
				? Effect.succeed(opts.cacheKey)
				: opts.cacheKey;

	// `needs` is a positional array; the substrate wants a typed record.
	// Synthesize stable alias keys (`need0`, `need1`, …) so each entry
	// participates in `__upstreamKeys` auto-flattening without forcing
	// callers to name them. The build callback yields needs itself via
	// closure capture, so the synthetic alias is only an identity hook.
	const needs = opts.needs ?? [];
	const needsRecord: Record<string, LayeredTag<any, any, any, any>> = {};
	for (let i = 0; i < needs.length; i++) {
		needsRecord[`need${i}`] = needs[i]!;
	}
	// `upstream` carries `signer` (typed alias used by the inputs body) plus
	// every need (positional alias purely for `__upstreamKeys` flattening).
	// The substrate yields each entry at acquire time, so by the time `build`
	// runs every needed ref has been resolved and registered.
	const upstream = { signer: opts.signer, ...needsRecord } as {
		readonly signer: LayeredTag<any, Account, any, any>;
	} & Record<string, LayeredTag<any, any, any, any>>;

	return onChainArtifact({
		name,
		kind: 'action',
		plugin: 'action',
		displayTitle: `tx.${name}`,
		display: (s: TxResult) => ({
			title: `tx.${name}`,
			primary: `digest ${s.digest}`,
			...(s.objectChanges.length > 0
				? {
						extras: [
							`${s.objectChanges.length} object${s.objectChanges.length === 1 ? '' : 's'}`,
						],
					}
				: {}),
		}),

		// Bare namespace per Phase B contract — `chainId` and the hashed
		// inputs (folded from name + signer.address + needs[].key + the
		// optional `cacheKey`) supply the per-instance distinction.
		namespace: 'action',
		label: `Action(${name})`,

		upstream,

		// Hashable inputs — fold the action's identity (`name`), the
		// signer's address, every need's tag key, and the user-supplied
		// `cacheKey` (when set) into a deterministic record. Builder /
		// gasBudget are NOT hashed: the build callback is an arbitrary
		// closure and the substrate cannot canonicalize a function body.
		// Callers that mutate the build body in a way that should miss
		// the cache pass a fresh `cacheKey` value.
		inputs: ({ signer }) =>
			Effect.gen(function* () {
				const userKey =
					cacheKeyEff === undefined
						? undefined
						: yield* (cacheKeyEff as Effect.Effect<string, unknown, never>);
				return {
					name,
					signer: signer.address,
					needs: needs.map((n) => n.key),
					...(userKey !== undefined ? { userKey } : {}),
				};
			}),

		// Verify the cached TxResult's digest still resolves on chain
		// via `ChainProbe.getTransaction(digest)`. Per RS2 — probe stable
		// identifiers, not derived shapes. A regenesis flips
		// `sui.chainId` and misses the cache outright; a snapshot-resume
		// against a chain where the digest no longer exists surfaces here
		// as verify-undefined and the next `produce` re-fires cleanly.
		// The probe is lenient (`ChainProbe.getTransaction` returns
		// `undefined` for any RPC failure) so transient blips don't
		// invalidate the cache.
		verify: ({ cached, chain }) =>
			chain
				.getTransaction(cached.digest)
				.pipe(Effect.map((tx) => (tx !== undefined ? cached : undefined))),

		// Fresh-fire body — runs on cache miss / verify-fail. Builds the
		// transaction (via the user's `build` callback), then signs and
		// executes against the resolved signer. Errors bubble through
		// `PublishError` so the supervisor's error surface stays narrow.
		produce: ({ signer }) =>
			Effect.gen(function* () {
				yield* setPhase('building');
				const t = new Transaction();
				if (opts.gasBudget !== undefined) {
					t.setGasBudget(opts.gasBudget);
				}
				yield* opts.build(t) as Effect.Effect<void, unknown, never>;
				yield* setPhase('executing');
				return yield* signer.signAndExecute(t).pipe(
					Effect.mapError(
						(cause) =>
							new PublishError({
								phase: 'publish-tx',
								message: `Action(${name}): sign+execute failed`,
								cause,
							}),
					),
				);
			}),

		// Action doesn't populate any in-process registries (no
		// PackageRegistry / CoinRegistry equivalent for ad-hoc txs), so
		// `register` is omitted. The substrate treats absence as a noop.
	});
};
