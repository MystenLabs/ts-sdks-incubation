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

import {
	acquireLive,
	validateLiveInputs,
	type KnownNetwork,
	type ResolvedLiveInputs,
	type SealServerKind,
} from './live.ts';
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
	readonly resolved: ResolvedLiveInputs;
}

/** Resolve the fork-known overrides + upstream-derived defaults into
 *  a resolved bundle. Pure synchronous projection — delegates to
 *  `validateLiveInputs` (the live branch's resolver) after mapping the
 *  upstream alias to a `KnownNetwork`, so the resolved `serverConfigs`
 *  (independent fan-out or committee) is threaded through unchanged.
 *  Throws `SealConfigError` on missing fields (matches the live
 *  branch's behaviour). */
export const validateForkKnownInputs = (inputs: {
	readonly name: string;
	readonly upstream: ForkUpstream;
	readonly server?: SealServerKind;
	readonly apiKeyName?: string;
	readonly apiKey?: string;
}): ResolvedLiveInputs => {
	try {
		return validateLiveInputs({
			name: inputs.name,
			network: resolveDeploymentNetwork(inputs.upstream),
			...(inputs.server !== undefined ? { server: inputs.server } : {}),
			...(inputs.apiKeyName !== undefined ? { apiKeyName: inputs.apiKeyName } : {}),
			...(inputs.apiKey !== undefined ? { apiKey: inputs.apiKey } : {}),
		});
	} catch (err) {
		// Re-throw the original tagged error so downstream
		// `Effect.catchTag('SealConfigError', …)` still matches.
		// Wrapping in `new Error(…)` would strip the `_tag` and turn
		// the typed refusal into an untyped runtime crash. Prepend the
		// upstream context to the message in-place instead.
		if (isSealConfigError(err)) {
			throw {
				...err,
				message: `seal.fork-known (upstream=${inputs.upstream}): ${err.message}`,
			};
		}
		throw err;
	}
};

const isSealConfigError = (
	value: unknown,
): value is { readonly _tag: 'SealConfigError'; readonly message: string; [k: string]: unknown } =>
	typeof value === 'object' &&
	value !== null &&
	(value as { _tag?: unknown })._tag === 'SealConfigError' &&
	typeof (value as { message?: unknown }).message === 'string';

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
