// Seal fork-known mode — *-fork networks route to the wrapped
// upstream's known key-server deployment.
//
// Distilled-doc §"Startup — `sealKnownKeyServer` (testnet / mainnet
// / fork)": structurally IDENTICAL to live mode. The only difference
// is the network resolver step at the barrel — `*-fork` networks
// route to the wrapped upstream (mainnet-fork → mainnet,
// testnet-fork → testnet, devnet-fork → devnet) BEFORE the
// known-deployment lookup fires.
//
// Distilled-doc invariant #13: `Seal()` on `*-fork` MUST route to
// `sealKnownKeyServer` with the wrapped upstream's deployment. The
// barrel (`index.ts`) enforces this via `resolveDeploymentNetwork`;
// this file's mode body simply consumes the resolved network the
// barrel passed.
//
// The mode body re-uses `acquireLive` since the boot pipeline is
// identical. We expose a distinct factory only so the mode-narrowed
// factory namespace (`sealFor(network).forkKnown(opts)`) can
// route by mode without leaking the live-mode internals.

import { Effect } from 'effect';

import { acquireLive, type KnownNetwork } from './live.ts';
import { sealError, type SealError } from '../errors.ts';
import type { SealKnownResolved } from '../registry-publish.ts';

// ---------------------------------------------------------------------------
// Fork → upstream network mapping
// ---------------------------------------------------------------------------

/** Map a fork upstream to its known-deployment lookup target. */
export type ForkUpstream = 'mainnet' | 'testnet' | 'devnet';

/** Resolve the wrapped upstream's known deployment key. Distilled-
 *  doc invariant #13. */
export const resolveDeploymentNetwork = (upstream: ForkUpstream): KnownNetwork => upstream;

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

export interface ForkKnownInputs {
	readonly name: string;
	readonly upstream: ForkUpstream;
	/** Explicit overrides (rare — the wrapped upstream's known
	 *  deployment is usually authoritative). */
	readonly objectId?: string;
	readonly keyServerUrl?: string;
}

// ---------------------------------------------------------------------------
// Mode acquire
// ---------------------------------------------------------------------------

/** Acquire body for the fork-known mode. Delegates to live mode
 *  with the resolved network. */
export const acquireForkKnown = (
	inputs: ForkKnownInputs,
): Effect.Effect<SealKnownResolved, SealError> =>
	acquireLive({
		name: inputs.name,
		network: resolveDeploymentNetwork(inputs.upstream),
		objectId: inputs.objectId,
		keyServerUrl: inputs.keyServerUrl,
	}).pipe(
		// Re-tag the error so the cause walker can attribute fork-mode
		// failures distinctly from live-mode failures.
		Effect.mapError((err) =>
			sealError('seal', {
				name: inputs.name,
				message: `seal.fork-known (upstream=${inputs.upstream}): ${err.message}`,
				cause: err,
			}),
		),
	);
