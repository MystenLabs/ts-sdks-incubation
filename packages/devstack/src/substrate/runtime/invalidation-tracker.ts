// Runtime invalidation tracker.
//
// The tracker is intentionally substrate-level: low-level cache and container
// decisions record when they had to produce/recreate state. It is optional for
// callers; outside a supervised boot the helper functions are no-ops.

import { Context, Effect, Layer, Option, Ref } from 'effect';

export type RuntimeInvalidationReason =
	| {
			readonly kind: 'artifact-produced';
			readonly namespace: string;
			readonly chain: string;
			readonly contentHash: string;
			readonly cause: 'cache-miss' | 'cache-corrupt' | 'verify-failed';
	  }
	| {
			readonly kind: 'docker-image-built';
			readonly tag: string;
	  }
	| {
			readonly kind: 'docker-image-pulled';
			readonly ref: string;
			readonly digest: string;
	  }
	| {
			readonly kind: 'container-created';
			readonly name: string;
			readonly cause: 'recreate' | 'resume-recreate';
	  };

export interface RuntimeInvalidationTracker {
	readonly record: (reason: RuntimeInvalidationReason) => Effect.Effect<void>;
	readonly reasons: Effect.Effect<ReadonlyArray<RuntimeInvalidationReason>>;
}

export class RuntimeInvalidationTrackerService extends Context.Service<
	RuntimeInvalidationTrackerService,
	RuntimeInvalidationTracker
>()('@devstack/substrate/RuntimeInvalidationTracker') {}

export const makeRuntimeInvalidationTracker = (): Effect.Effect<RuntimeInvalidationTracker> =>
	Effect.gen(function* () {
		const ref = yield* Ref.make<ReadonlyArray<RuntimeInvalidationReason>>([]);
		return {
			record: (reason) => Ref.update(ref, (reasons) => [...reasons, reason]),
			reasons: Ref.get(ref),
		};
	});

export const layerRuntimeInvalidationTracker: Layer.Layer<RuntimeInvalidationTrackerService> =
	Layer.effect(RuntimeInvalidationTrackerService, makeRuntimeInvalidationTracker());

/** Optional helper for low-level code that may run outside a supervised boot. */
export const recordRuntimeInvalidation = (reason: RuntimeInvalidationReason): Effect.Effect<void> =>
	Effect.gen(function* () {
		const tracker = yield* Effect.serviceOption(RuntimeInvalidationTrackerService);
		if (Option.isSome(tracker)) {
			yield* tracker.value.record(reason);
		}
	});
