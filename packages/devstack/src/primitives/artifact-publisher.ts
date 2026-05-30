// ArtifactPublisher — L0 substrate primitive (architecture §10).
//
// Unifies the discipline that recurs across many on-chain
// produce/verify plugins (substrate must remain service-name-blind;
// the plugin index is the authoritative list). cache → verify →
// produce → register on EVERY cycle.
//
// This is callable from any plugin; there is NO plugin-side contract
// to implement. Plugins pass in:
//
//   - a namespace + cache-key derivation,
//   - a verify procedure (calls ChainProbe with a typed Schema,
//     lenient mode),
//   - a produce procedure (run on miss / verify-fail),
//   - a register procedure (fires on EVERY cycle — hit AND miss).

import type { Effect, Scope } from 'effect';

import type { ChainId, ContentHash } from '../substrate/brand.ts';

/** Lenient retry profile constants — shared with ChainProbe.
 *  Architecture: 15 attempts, 90s budget, 500ms initial, 1.5×
 *  backoff, [0.8, 1.2) jitter. */
export const LENIENT_RETRY_PROFILE = {
	attempts: 15,
	totalBudgetMillis: 90_000,
	initialMillis: 500,
	backoffMultiplier: 1.5,
	jitterRange: [0.8, 1.2] as const,
} as const;

/** Input contract for ArtifactPublisher.publish. */
export interface ArtifactSpec<Produced, Verified> {
	/** Cache namespace — plugin-chosen, e.g. `package`. */
	readonly namespace: string;
	/** Chain identity — substrate folds into the cache key. */
	readonly chain: ChainId;
	/** Content-hash of canonical input bytes. */
	readonly contentHash: ContentHash;
	/** Verify probe — typed Schema; lenient mode. Returns null on
	 *  not-found OR transient failure.
	 *
	 *  The substrate decodes the cached payload (if any) and passes it
	 *  in as `cached`. Plugins that key their on-chain probe off a
	 *  field of the cached payload (e.g. action's `digest`, package's
	 *  `packageId`) read it from here directly — no in-process
	 *  registry-hop required. Plugins that don't care about the
	 *  cached payload ignore the parameter.
	 *
	 *  When the cache is empty (cold boot) OR decode failed
	 *  (corruption) the substrate short-circuits to "miss" before
	 *  invoking this; callers can therefore assume `cached` is
	 *  defined on every call. */
	readonly verify: (cached: Produced) => Effect.Effect<Verified | null, never>;
	/** Produce procedure — runs on cache miss OR verify-fail. */
	readonly produce: Effect.Effect<Produced, ArtifactPublishError, Scope.Scope>;
	/** Register procedure — fires on EVERY cycle (hit AND miss). The
	 *  substrate always hands back the decoded `Produced` payload (on
	 *  cache hit) or the freshly produced one (on miss); the verify
	 *  shape is a probe-only signal, never surfaced to callers. */
	readonly register: (artifact: Produced) => Effect.Effect<void, never>;
}

/** Tagged error from a publish round. */
export interface ArtifactPublishError {
	readonly _tag: 'ArtifactPublishError';
	readonly reason: 'produce-failed' | 'verify-exhausted' | 'cache-corrupt';
	readonly detail: string;
}

/** Constructor for `ArtifactPublishError`. Centralising the literal
 *  shape (single `_tag` site, no `as const` ceremony at call sites)
 *  per STYLE_GUIDE §2: tagged errors expose a factory at every
 *  plugin/public boundary. Every plugin's `produce` /
 *  `Effect.mapError` path goes through this. */
export const artifactPublishError = (
	reason: ArtifactPublishError['reason'],
	detail: string,
): ArtifactPublishError => ({
	_tag: 'ArtifactPublishError',
	reason,
	detail,
});

/** The publisher service. Plugins call `publish`; substrate handles
 *  cache lookup, verify, produce-on-miss, idempotent register.
 *
 *  Returns the `Produced` payload on EVERY path:
 *  - cache hit + verify succeeds → the decoded cached `Produced`,
 *  - cache miss or verify-fail → the freshly produced `Produced`.
 *
 *  The `Verified` shape is a probe-only signal (drives the lenient
 *  null/non-null decision inside the substrate); it is never returned
 *  to plugin callers. Callers therefore type-narrow trivially against
 *  `Produced` and avoid the `'<sentinel>'` projection dance. */
export interface ArtifactPublisher {
	readonly publish: <Produced, Verified>(
		spec: ArtifactSpec<Produced, Verified>,
	) => Effect.Effect<Produced, ArtifactPublishError, Scope.Scope>;
}
