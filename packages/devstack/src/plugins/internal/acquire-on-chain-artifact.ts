// acquireOnChainArtifact — thin compactor over `ArtifactPublisher.publish`.
//
// Recurs across plugins that publish on-chain artifacts (coin/mint,
// deepbook/pyth, deepbook/deploy, …). All three sites share:
//
//   - the `register: () => Effect.void` no-op (these plugins keep no
//     in-process registry — the cached payload IS the resolved value),
//   - the `publish<Produced, Verified>({namespace, chain, contentHash,
//     verify, produce, register})` skeleton.
//
// The helper does NOT touch the `produce` body itself: the three
// consumers' produce pipelines diverge meaningfully (coin/mint uses
// `signAndDispatch` against the Account bus; deepbook/{pyth,deploy} use
// `executeSuiTx` against the raw SDK client). Forcing a union over those
// shapes would either widen the helper to the point of unhelpfulness or
// regress one of the consumers. Each consumer continues to compose its
// own `produce`; the helper centralises the surrounding boilerplate.
//
// For the rarer "phase-preserving produce" pattern (action plugin's
// Ref-stash to recover typed-error phases across the substrate's
// ArtifactPublishError wrap), see
// `substrate/runtime/phase-preserving-produce.ts`.
//
// Boundary discipline: this module lives under `plugins/internal/`
// because it consumes the public `ArtifactPublisher` surface AND the
// public `ContentHash` brand. No plugin-domain types leak in;
// callers project the `Produced` payload to their resolved value
// themselves.

import { Effect, type Scope } from 'effect';

import type { ContentHash } from '../../substrate/brand.ts';
import {
	type ArtifactPublishError,
	type ArtifactPublisher,
	type ArtifactSpec,
} from '../../primitives/artifact-publisher.ts';

/** Spec slice consumed by `acquireOnChainArtifact`. Mirrors
 *  `ArtifactSpec<Produced, Verified>` minus the `register` field — the
 *  helper supplies the universal `() => Effect.void` register for
 *  artifact plugins with no in-process registry to feed. */
export interface AcquireOnChainArtifactSpec<Produced, Verified> {
	readonly namespace: string;
	readonly chain: string;
	readonly contentHash: ContentHash;
	readonly verify: ArtifactSpec<Produced, Verified>['verify'];
	readonly produce: ArtifactSpec<Produced, Verified>['produce'];
}

/** Submit an on-chain artifact spec with the universal
 *  `register: () => Effect.void` no-op baked in. Returns the substrate's
 *  resolved `Produced` payload (decoded cached payload on verify-hit;
 *  freshly produced payload on miss).
 *
 *  Callers that need a non-void `register` (or a phase-preserving
 *  produce wrap) should consume the underlying `publisher.publish`
 *  surface directly. */
export const acquireOnChainArtifact = <Produced, Verified>(
	publisher: ArtifactPublisher,
	spec: AcquireOnChainArtifactSpec<Produced, Verified>,
): Effect.Effect<Produced, ArtifactPublishError, Scope.Scope> =>
	publisher.publish<Produced, Verified>({
		namespace: spec.namespace,
		chain: spec.chain,
		contentHash: spec.contentHash,
		verify: spec.verify,
		produce: spec.produce,
		// Register on EVERY cycle (hit AND miss) — substrate contract
		// (architecture §10). The on-chain-artifact plugins this helper
		// serves keep no in-process registry; the cached payload carries
		// everything callers need.
		register: () => Effect.void,
	});
