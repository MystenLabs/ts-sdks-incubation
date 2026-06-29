// Walrus plugin — typed errors.
//
// Errors raised and consumed inside the Walrus plugin live here.
// Cross-service errors that Walrus *consumes* but the substrate
// raises (e.g. `ArtifactPublishError`) come from the substrate's
// primitive — we don't redeclare those.
//
// `ForkIncompatibleError` is a cross-cutting mode-refusal shape
// owned by `substrate/runtime/mode-errors.ts`; walrus contributes
// the `walrusLocalCluster` variant via the factory below.
//
// Effect v4: plain interfaces with `_tag` discriminator (per
// surrounding subsystem style). `Effect.catchTag` matches on `_tag`.

import { ForkIncompatibleError } from '../../substrate/runtime/mode-errors.ts';
import { defineConfigError, type ConfigIssue } from '../../substrate/runtime/config-validation.ts';

export { ForkIncompatibleError };

/** Phases for `WalrusError`. Closed sum — keeps the cause-walker's
 *  display table small. Matches the closed `WalrusPhases` from the
 *  distilled doc §"Cross-component references" except `'network'`
 *  is dropped (the substrate's `ContainerRuntime` owns docker network
 *  creation now, so its errors surface as `ContainerRuntimeError`
 *  upstream — we narrate the *phase* as `'cluster-network'` but the
 *  fault tags through the substrate). */
export type WalrusPhase =
	| 'image-build'
	| 'cluster-network'
	| 'deploy'
	| 'aggregator'
	| 'publisher'
	| 'exchange'
	| 'storage-node'
	| 'proxy'
	| 'fund-wal'
	| 'register-known';

/** Generic Walrus plugin error. Raised by the plugin's acquire
 *  body, WAL funding strategy, and the per-mode builders. */
export interface WalrusPluginError {
	readonly _tag: 'WalrusPluginError';
	readonly phase: WalrusPhase;
	readonly message: string;
	readonly cause?: unknown;
	/** Optional sub-process capture envelope — populated for deploy
	 *  one-shot + per-node container failures. */
	readonly stderr?: string;
	readonly stdout?: string;
	readonly exitCode?: number;
}

export const walrusPluginError = (
	phase: WalrusPhase,
	message: string,
	parts: Omit<WalrusPluginError, '_tag' | 'phase' | 'message'> = {},
): WalrusPluginError => ({ _tag: 'WalrusPluginError', phase, message, ...parts });

/** Configuration error — synchronous factory-time guards
 *  (`nodeCount >= 1`, `shards >= nodeCount`, missing required
 *  fields on `.known(...)`). Surfaces as a thrown `Error` shaped
 *  like this in the factory, mirroring the distilled-doc behavior
 *  of synchronous configuration faults. */
export interface WalrusConfigError extends ConfigIssue {
	readonly _tag: 'WalrusConfigError';
}

const makeWalrusConfigError = defineConfigError('WalrusConfigError');

export const walrusConfigError = (
	field: string,
	message: string,
	hint?: string,
	cause?: unknown,
): WalrusConfigError => makeWalrusConfigError({ field, message, hint, cause });

/** Union of every error a Walrus-plugin caller may encounter. */
export type WalrusError = WalrusPluginError | ForkIncompatibleError | WalrusConfigError;

/** The catchable error tags this plugin exposes. Pinned against the
 *  user-facing error catalog by the error-catalog-parity test. */
export const WALRUS_ERROR_TAGS: ReadonlyArray<WalrusError['_tag']> = [
	'WalrusPluginError',
	'ForkIncompatibleError',
	'WalrusConfigError',
] as const;
