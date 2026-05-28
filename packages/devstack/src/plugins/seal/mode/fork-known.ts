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

import { acquireLive, validateLiveInputs, type KnownNetwork } from './live.ts';
import type { SealError } from '../errors.ts';
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

/** Pre-validated fork-known inputs. Symmetric with the live mode's
 *  `{ name, resolved }` shape — the barrel resolves
 *  `upstream → KnownNetwork → validated tuple` synchronously at
 *  factory time so both branches reach `acquireLive` with the same
 *  structural envelope. */
export interface ForkKnownInputs {
	readonly name: string;
	readonly upstream: ForkUpstream;
	readonly resolved: { readonly objectId: string; readonly keyServerUrl: string };
}

/** Resolve the fork-known overrides + upstream-derived defaults into
 *  a validated tuple. Pure synchronous projection — mirrors the
 *  factory-boundary `validateLiveInputs` call in `index.ts` for the
 *  live branch. Throws on missing fields after fallback (matches the
 *  live branch's behaviour — see `validateLiveInputs`). */
export const validateForkKnownInputs = (inputs: {
	readonly name: string;
	readonly upstream: ForkUpstream;
	readonly objectId?: string;
	readonly keyServerUrl?: string;
}): { readonly objectId: string; readonly keyServerUrl: string } => {
	try {
		return validateLiveInputs({
			name: inputs.name,
			network: resolveDeploymentNetwork(inputs.upstream),
			objectId: inputs.objectId,
			keyServerUrl: inputs.keyServerUrl,
		});
	} catch (err) {
		throw new Error(
			`seal.fork-known (upstream=${inputs.upstream}): ${err instanceof Error ? err.message : String(err)}`,
		);
	}
};

// ---------------------------------------------------------------------------
// Mode acquire
// ---------------------------------------------------------------------------

/** Acquire body for the fork-known mode. Inputs already pre-validated
 *  by the barrel via `validateForkKnownInputs`; delegates the
 *  read-side projection to live mode. The `upstream` field rides
 *  through for downstream span attribution.
 *
 *  Error channel kept typed as `SealError` for forward-compatibility
 *  with any future fallible work this body needs to do (currently
 *  `acquireLive` is `Effect.sync` so the channel is effectively
 *  `never`). */
export const acquireForkKnown = (
	inputs: ForkKnownInputs,
): Effect.Effect<SealKnownResolved, SealError> =>
	acquireLive({ name: inputs.name, resolved: inputs.resolved });
