// Sui plugin — service body.
//
// Architecture: the four modes are NOT four separate plugins. They
// are one plugin with internal mode dispatch. The factory at the
// barrel (`index.ts`) constructs a `SuiOptions` discriminator from
// typed options; the `acquire` body below dispatches on `opts.mode`
// and assembles the mode-appropriate subsystems.
//
// What this file does:
//
//   1. Receive resolved `SuiOptions`.
//   2. Dispatch to the right `bootXxxMode` builder.
//   3. Assemble the mode-aware `SuiClient` (the resolved value).
//
// What it does NOT do:
//
//   - Provision the build container — `chain-build-container.ts`
//     owns that; the plugin acquires it ONLY when needed (Move
//     publish or codegen) via the ArtifactPublisher seam.
//   - Wire the StrategyContributor capabilities — that's the
//     barrel's job; the body just returns the resolved value.

import { Effect, type Scope } from 'effect';

import type { SeedManifestMismatchError, SuiConfigError, SuiPluginError } from './errors.ts';
import type { ResolvedSuiNetwork } from './network-resolver.ts';
import type { SuiClient } from './mode/shared.ts';
import type { SuiOptions } from './mode/spec.ts';
import { bootLocalRpcMode } from './mode/external.ts';
import { bootForkMode } from './mode/fork.ts';
import { bootLiveMode } from './mode/live.ts';
import { bootLocalMode } from './mode/local.ts';
import type { ContainerRuntime } from '../../contracts/container-runtime.ts';
import type { Identity } from '../../substrate/identity.ts';
import type { StackPaths } from '../../substrate/runtime/paths.ts';
import type { PortBroker } from '../../substrate/runtime/port-broker/index.ts';

/** Bundled result of one acquire — resolved metadata + the user-facing
 *  client. The barrel projects this into the Sui resource value; the
 *  resolved metadata feeds the Codegenable contribution. */
export interface SuiBootResult {
	readonly resolved: ResolvedSuiNetwork;
	readonly client: SuiClient;
}

/** Dispatch on the typed mode and return the mode's boot artifacts.
 *
 *  The `ContainerRuntime` is consumed by container-bearing modes
 *  only (local + fork); external + live get `null` and a typed
 *  refusal would surface if they tried to use it.
 *
 *  Stub: the per-mode builders are all stubs; the orchestrator
 *  here is the only fully-wired piece. */
export const bootSuiService = (
	runtime: ContainerRuntime,
	identity: Identity,
	portBroker: PortBroker,
	paths: StackPaths,
	opts: SuiOptions,
): Effect.Effect<
	SuiBootResult,
	SuiPluginError | SeedManifestMismatchError | SuiConfigError,
	Scope.Scope
> => {
	switch (opts.mode) {
		case 'local':
			return bootLocalMode(runtime, identity, portBroker, opts).pipe(
				Effect.map(({ resolved, client }) => ({ resolved, client })),
			);
		case 'local-rpc':
			return bootLocalRpcMode(opts).pipe(
				Effect.map(({ resolved, client }) => ({ resolved, client })),
			);
		case 'live':
			return bootLiveMode(opts).pipe(Effect.map(({ resolved, client }) => ({ resolved, client })));
		case 'fork':
			return bootForkMode(runtime, identity, portBroker, paths, opts).pipe(
				Effect.map(({ resolved, client }) => ({ resolved, client })),
			);
	}
};
