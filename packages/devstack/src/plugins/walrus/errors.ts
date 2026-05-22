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
	| 'exchange'
	| 'storage-node'
	| 'proxy'
	| 'seed-wal'
	| 'register-known';

/** Generic Walrus plugin error. Raised by the plugin's acquire
 *  body, its admin surface (`seedWal`), and the per-mode builders. */
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

/**
 * Synchronous factory-time refusal when the user explicitly composes
 * the local-cluster mode against a fork network.
 *
 * sui-fork doesn't expose JSON-RPC; the local cluster's storage
 * nodes need JSON-RPC against the chain. Letting the supervisor
 * partway through the image build before the nodes fail to dial
 * would be confusing — we refuse synchronously at factory time
 * with an actionable hint pointing at `walrus()` (auto-routes to
 * known-deployment) or `walrusFor(network).known({...})`.
 *
 * Primary refusal is TYPE-LEVEL via the `walrusFor(network).<mode>`
 * mode-narrowed namespace — fork networks expose only `.known`, so
 * calling `.local` is a compile error. This runtime shape is
 * defense-in-depth for callers that sneak through (e.g. the
 * env-driven `walrus()` factory composing `walrusFor` indirectly).
 */
export const forkIncompatibleError = (network: string): ForkIncompatibleError =>
	new ForkIncompatibleError({
		variant: 'walrusLocalCluster',
		network,
		message: `walrus local-cluster does not support fork networks.`,
		hint:
			`walrus local-cluster requires JSON-RPC, which sui-fork does not expose. ` +
			`Use walrus() (auto-routes to known-deployment) or ` +
			`walrusFor(network).known({...}) instead.`,
	});

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

/** Error tags this plugin contributes — surfaced to the cause
 *  walker via `PluginErrorContribution`. */
export const WALRUS_ERROR_TAGS: ReadonlyArray<WalrusError['_tag']> = [
	'WalrusPluginError',
	'ForkIncompatibleError',
	'WalrusConfigError',
] as const;
