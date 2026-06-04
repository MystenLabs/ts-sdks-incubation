// Identity guard — fail-closed cross-chain refusal.
//
// Architecture § Snapshot:
//   "Identity guard. `(app, stack, network)` plus chain identity plus
//   optional plugin contributions. Fires before any destructive
//   mutation."
//
// Architecture § Invariants:
//   "Cross-chain refusal. When both the snapshot and the live stack
//   carry a known chain identity and they disagree, restore must
//   refuse before any destructive mutation."
//
// Composition shape: the orchestrator collects an `IdentitySlice`
// from EACH participating plugin's `preRestore` contribution. The
// final guard compares the snapshot's stored slice against the live
// slice key-by-key. A disagreement on ANY key refuses. A key set on
// one side but not the other is decided by the fail-closed policy:
// the orchestrator's policy is fail-closed-when-snapshot-set (open
// question §5 resolution): if the snapshot recorded `chain=X` and the
// caller did not pass `chain`, the guard refuses with `missing-live`.

import { Effect, Schema } from 'effect';

import type { IdentitySlice } from './descriptor.ts';

export interface SnapshotRuntimeIdentity {
	readonly app: string;
	readonly stack: string;
	readonly network: string;
}

// -----------------------------------------------------------------------------
// Errors
// -----------------------------------------------------------------------------

/** Tagged failure: chain identity (or another contributed key) disagrees
 *  between the snapshot and the live stack. No mutation occurred. */
export class IdentityMismatchError extends Schema.TaggedErrorClass<IdentityMismatchError>()(
	'SnapshotIdentityMismatch',
	{
		phase: Schema.Literal('identity-guard'),
		key: Schema.String,
		snapshotValue: Schema.String,
		liveValue: Schema.String,
	},
) {}

/** Tagged failure: snapshot recorded a key that the live stack did
 *  not contribute. Fail-closed (architecture open question §5
 *  resolution); the alternative is silently restoring across an
 *  unverified seam. */
export class IdentityMissingLiveError extends Schema.TaggedErrorClass<IdentityMissingLiveError>()(
	'SnapshotIdentityMissingLive',
	{
		phase: Schema.Literal('identity-guard'),
		key: Schema.String,
		snapshotValue: Schema.String,
	},
) {}

/** Tagged failure: live stack contributed a key the snapshot did NOT
 *  record. Fail-closed for the same reason as above — restoring an
 *  older snapshot that pre-dates the contribution is a code-version
 *  mismatch, not a happy path. */
export class IdentityMissingSnapshotError extends Schema.TaggedErrorClass<IdentityMissingSnapshotError>()(
	'SnapshotIdentityMissingSnapshot',
	{
		phase: Schema.Literal('identity-guard'),
		key: Schema.String,
		liveValue: Schema.String,
	},
) {}

export class IdentityEmptyError extends Schema.TaggedErrorClass<IdentityEmptyError>()(
	'SnapshotIdentityEmpty',
	{
		phase: Schema.Literal('identity-guard'),
		source: Schema.Literals(['snapshot', 'live']),
	},
) {}

export type IdentityGuardError =
	| IdentityMismatchError
	| IdentityMissingLiveError
	| IdentityMissingSnapshotError
	| IdentityEmptyError;

// -----------------------------------------------------------------------------
// Composition — many plugins, one merged slice
// -----------------------------------------------------------------------------

/** One participant's contribution to the identity slice — produced by
 *  the plugin's `preRestore` hook, schema-decoded by the orchestrator. */
export interface IdentityContribution {
	readonly plugin: string;
	readonly slice: IdentitySlice;
}

/** Tagged failure: two plugins contributed the same key with different
 *  values. The orchestrator surfaces this BEFORE running the guard;
 *  same-key contributions from independent plugins should agree (the
 *  same chain identity contributed by sui and a probe-renderer, say). */
export class IdentityContributionConflictError extends Schema.TaggedErrorClass<IdentityContributionConflictError>()(
	'SnapshotIdentityContributionConflict',
	{
		phase: Schema.Literal('identity-guard'),
		key: Schema.String,
		conflictingPlugins: Schema.Array(Schema.String),
		values: Schema.Array(Schema.String),
	},
) {}

/**
 * Merge a list of plugin contributions into one slice. Conflict
 * (same key, different values across plugins) surfaces as a tagged
 * error — the orchestrator refuses to proceed rather than picking a
 * "winner" silently.
 *
 * Architecture § Snapshotable: identity contributions stack — chain
 * is the canonical case but plugins are free to contribute their own
 * (e.g. postgres major version, sui fork checkpoint).
 */
export const mergeContributions = (
	contributions: ReadonlyArray<IdentityContribution>,
): Effect.Effect<IdentitySlice, IdentityContributionConflictError> =>
	Effect.gen(function* () {
		// Group by key so the conflict surface lists every offender.
		const seen: Record<string, ReadonlyArray<{ plugin: string; value: string }>> = {};
		for (const { plugin, slice } of contributions) {
			for (const [key, value] of Object.entries(slice)) {
				const prior = seen[key] ?? [];
				seen[key] = [...prior, { plugin, value }];
			}
		}
		const merged: Record<string, string> = {};
		for (const [key, entries] of Object.entries(seen)) {
			const distinct = new Set(entries.map((e) => e.value));
			if (distinct.size > 1) {
				return yield* Effect.fail(
					new IdentityContributionConflictError({
						phase: 'identity-guard',
						key,
						conflictingPlugins: entries.map((e) => e.plugin),
						values: [...distinct],
					}),
				);
			}
			// `distinct.size === 1` guaranteed (every entry contributes one value).
			merged[key] = entries[0]!.value;
		}
		return merged;
	});

// -----------------------------------------------------------------------------
// The guard itself
// -----------------------------------------------------------------------------

export const requireIdentity = (
	identity: IdentitySlice,
	source: IdentityEmptyError['source'],
): Effect.Effect<void, IdentityEmptyError> =>
	Object.keys(identity).length === 0
		? Effect.fail(new IdentityEmptyError({ phase: 'identity-guard', source }))
		: Effect.void;

/**
 * Compare the snapshot's recorded identity against the live stack's
 * contributed identity. Fail-closed on every shape:
 *
 *   - snapshot identity is empty                    → IdentityEmptyError
 *   - keys present on both sides, values differ → IdentityMismatchError
 *   - keys present only in the snapshot          → IdentityMissingLiveError
 *   - keys present only in the live stack        → IdentityMissingSnapshotError
 *
 * The architecture's open-question §5 ("require both sides of the
 * comparison rather than fail-open on either-undefined") resolves to
 * fail-closed; this is the implementation.
 *
 * The guard runs BEFORE any destructive mutation. On a successful
 * return there is no I/O effect to roll back.
 */
export const runIdentityGuard = (
	snapshotIdentity: IdentitySlice,
	liveIdentity: IdentitySlice,
): Effect.Effect<void, IdentityGuardError> =>
	Effect.gen(function* () {
		const snapshotKeys = Object.keys(snapshotIdentity);
		const liveKeys = Object.keys(liveIdentity);
		yield* requireIdentity(snapshotIdentity, 'snapshot');
		// 1. Keys present on both sides — disagreement is the canonical refuse.
		for (const key of snapshotKeys) {
			if (key in liveIdentity) {
				if (snapshotIdentity[key] !== liveIdentity[key]) {
					return yield* Effect.fail(
						new IdentityMismatchError({
							phase: 'identity-guard',
							key,
							snapshotValue: snapshotIdentity[key]!,
							liveValue: liveIdentity[key]!,
						}),
					);
				}
			}
		}
		// 2. Snapshot recorded a key live did not contribute. Fail-closed.
		for (const key of snapshotKeys) {
			if (!(key in liveIdentity)) {
				return yield* Effect.fail(
					new IdentityMissingLiveError({
						phase: 'identity-guard',
						key,
						snapshotValue: snapshotIdentity[key]!,
					}),
				);
			}
		}
		// 3. Live contributed a key the snapshot did not record. Fail-closed.
		for (const key of liveKeys) {
			if (!(key in snapshotIdentity)) {
				return yield* Effect.fail(
					new IdentityMissingSnapshotError({
						phase: 'identity-guard',
						key,
						liveValue: liveIdentity[key]!,
					}),
				);
			}
		}
	});

export const runRuntimeIdentityGuard = (
	snapshotIdentity: SnapshotRuntimeIdentity,
	liveIdentity: SnapshotRuntimeIdentity,
): Effect.Effect<void, IdentityMismatchError> =>
	Effect.gen(function* () {
		const keys: ReadonlyArray<keyof SnapshotRuntimeIdentity> = ['app', 'stack', 'network'];
		for (const key of keys) {
			if (snapshotIdentity[key] !== liveIdentity[key]) {
				return yield* Effect.fail(
					new IdentityMismatchError({
						phase: 'identity-guard',
						key,
						snapshotValue: snapshotIdentity[key],
						liveValue: liveIdentity[key],
					}),
				);
			}
		}
	});
