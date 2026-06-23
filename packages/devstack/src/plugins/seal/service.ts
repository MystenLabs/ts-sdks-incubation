// Seal plugin — known-mode dispatch (live + fork-known).
//
// Local-keygen mode is dispatched directly from the plugin barrel
// (`index.ts`) via `bootLocalKeygen` because it needs a
// `LocalKeygenDeps` bundle (ContainerRuntime, paths, identity, …)
// composed from substrate services. This file only routes the two
// pure-value-producing modes that need no substrate plumbing.

import { Effect, type Scope } from 'effect';

import type {
	ArtifactPublishError,
	ArtifactPublisher,
} from '../../primitives/artifact-publisher.ts';
import type { SealAnyError } from './errors.ts';
import { acquireForkKnown, type ForkKnownInputs } from './mode/fork-known.ts';
import { acquireLive, type ResolvedLiveInputs } from './mode/live.ts';
import type { SealKnownResolved } from './registry-publish.ts';

/** Known-mode discriminator — live + fork-known only. */
export type SealMode =
	| {
			readonly mode: 'live';
			readonly name: string;
			readonly resolved: ResolvedLiveInputs;
	  }
	| ({ readonly mode: 'fork-known' } & ForkKnownInputs);

export type SealKnownBootResult = SealKnownResolved;

/** Dispatch on the known-mode discriminator. The publisher argument
 *  is unused by the known paths (no on-chain artifact produce); it's
 *  accepted for shape uniformity with the local-keygen entry point. */
export const bootSealService = (
	_publisher: ArtifactPublisher,
	opts: SealMode,
): Effect.Effect<SealKnownBootResult, SealAnyError | ArtifactPublishError, Scope.Scope> => {
	switch (opts.mode) {
		case 'live':
			return acquireLive(opts);
		case 'fork-known':
			return acquireForkKnown(opts);
	}
};
