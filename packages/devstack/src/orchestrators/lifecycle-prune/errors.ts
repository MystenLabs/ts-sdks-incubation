// Tagged failures for the lifecycle-prune orchestrator.
//
// Per STYLE_GUIDE §2.2: orchestrator-level failures use
// `Schema.TaggedErrorClass`; never plain `Error`; never `unknown` at
// the public surface. The orchestrator's underlying L1 docker calls
// raise `DockerRuntimeError` (itself a union of 16+ tagged errors);
// we project each underlying failure onto a single phase-tagged
// envelope so CLI consumers can `Effect.catchTag('LifecyclePruneError')`
// and branch on `phase` instead of inspecting the L1 union directly.

import { Schema } from 'effect';

import type { DockerRuntimeError } from '../../runtime/docker/errors.ts';

/** Phase discriminator: which step of the cross-stack sweep failed.
 *  `inventory` covers the parallel listDevstack* fan-out and the
 *  per-group bucketing; the four `remove-*` phases cover the
 *  resource-specific sweep loops in `runLifecyclePrune`. */
export const LifecyclePrunePhase = Schema.Literals([
	'inventory',
	'remove-containers',
	'remove-networks',
	'remove-volumes',
	'remove-images',
]);
export type LifecyclePrunePhase = typeof LifecyclePrunePhase.Type;

export class LifecyclePruneError extends Schema.TaggedErrorClass<LifecyclePruneError>()(
	'LifecyclePruneError',
	{
		phase: LifecyclePrunePhase,
		detail: Schema.String,
		cause: Schema.optional(Schema.Defect),
	},
) {}

/** Curry: `phase` → `(DockerRuntimeError) → LifecyclePruneError`.
 *  Used as `Effect.mapError(failPhase('inventory'))` to project the L1
 *  docker error union onto a single phase-tagged envelope while
 *  preserving the underlying cause for diagnostics. */
export const failPhase =
	(phase: LifecyclePrunePhase) =>
	(cause: DockerRuntimeError): LifecyclePruneError =>
		new LifecyclePruneError({
			phase,
			detail: `${phase}: ${cause._tag}`,
			cause,
		});
