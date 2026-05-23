// Package plugin — main acquire body.
//
// Dispatch on `opts.mode` ∈ {local, known} and delegate to the
// per-mode acquire. This file is INTENTIONALLY thin: the substrate
// concerns (cache key, verify, produce, register) live inside the
// ArtifactPublisher primitive; the toolchain concerns (build,
// scrub) live in `build.ts`. We just route.
//
// Substrate dependencies arrive via `definePlugin({ dependsOn })`:
//
//   - suiResource           — resolved SuiClient + chainId
//   - publisher account     — publisher address + sign-and-execute
//
// And via the StrategyContributor registry (by capability key):
//
//   - chain-probe:<chainId> — ChainProbe<SuiProbeKey>
//   - artifact-publisher     — the ArtifactPublisher (substrate
//                             primitive, available everywhere)
//
// And via the plugin-owned PackageRegistry service (instantiated from
// the substrate's generic ScopedRefMap primitive — see `registry.ts`).
//
// The wiring of these lookups happens at the barrel (`index.ts`); this
// file accepts them as parameters so it stays testable.

import { Effect, type Scope } from 'effect';

import type {
	ArtifactPublishError,
	ArtifactPublisher,
} from '../../primitives/artifact-publisher.ts';
import type { ChainProbe } from '../../contracts/chain-probe.ts';
import type { SuiProbeKey } from '../sui/chain-probe.ts';
import { acquireKnown, type KnownModeInputs } from './mode-known.ts';
import { acquireLocal, type LocalModeInputs } from './mode-local.ts';
import type {
	PackageRegistry,
	ResolvedKnownPackage,
	ResolvedLocalPackage,
	ResolvedPackage,
} from './registry.ts';
import type { LocalPackagePublishOutput } from './publish-output.ts';
import type { PublishError } from './errors.ts';

/** Discriminated mode union — mirrors the public factory shape
 *  (`localPackage(...)` and `knownPackage(...)`). The barrel
 *  constructs ONE of these per declared package and the body below
 *  routes. */
export type PackageMode =
	| ({ readonly mode: 'local' } & LocalModeInputs)
	| ({ readonly mode: 'known' } & KnownModeInputs);

export interface BootPackageResult {
	readonly resolved: ResolvedPackage;
	/** Fresh publish output — populated on cache MISS (the produce
	 *  path ran), `null` on cache hit (verify path). Threaded out so
	 *  the barrel can fan out coin auto-discovery (and any other
	 *  output-consuming siblings) once per fresh publish.
	 *
	 *  Known mode never publishes, so this is always `null` there. */
	readonly output: LocalPackagePublishOutput | null;
}

export interface BootLocalPackageResult {
	readonly resolved: ResolvedLocalPackage;
	readonly output: LocalPackagePublishOutput | null;
}

export interface BootKnownPackageResult {
	readonly resolved: ResolvedKnownPackage;
	readonly output: null;
}

/** Dispatch on the typed mode. */
export function bootPackageService(
	publisher: ArtifactPublisher,
	probe: ChainProbe<SuiProbeKey>,
	registry: PackageRegistry,
	opts: { readonly mode: 'local' } & LocalModeInputs,
): Effect.Effect<BootLocalPackageResult, PublishError | ArtifactPublishError, Scope.Scope>;
export function bootPackageService(
	publisher: ArtifactPublisher,
	probe: ChainProbe<SuiProbeKey>,
	registry: PackageRegistry,
	opts: { readonly mode: 'known' } & KnownModeInputs,
): Effect.Effect<BootKnownPackageResult, PublishError | ArtifactPublishError, Scope.Scope>;
export function bootPackageService(
	publisher: ArtifactPublisher,
	probe: ChainProbe<SuiProbeKey>,
	registry: PackageRegistry,
	opts: PackageMode,
): Effect.Effect<BootPackageResult, PublishError | ArtifactPublishError, Scope.Scope> {
	switch (opts.mode) {
		case 'local':
			return acquireLocal(publisher, probe, registry, opts).pipe(
				Effect.map(({ resolved, output }) => ({ resolved, output })),
			);
		case 'known':
			return acquireKnown(probe, registry, opts).pipe(
				Effect.map(({ resolved }) => ({ resolved, output: null })),
			);
	}
}
