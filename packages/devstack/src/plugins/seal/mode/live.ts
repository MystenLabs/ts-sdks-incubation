// Seal live mode — testnet / mainnet known key server.
//
// Distilled-doc §"Startup — `sealKnownKeyServer`": far simpler than
// the local-keygen path.
//
//   1. Look up the known deployment (or accept explicit overrides).
//   2. Publish the endpoint + state-store entry to the substrate
//      registries (the codegen + manifest emitters consume these).
//   3. Return the read-side handle.
//
// NO chain interactions, NO docker, NO state-store writes, NO
// keygen. Distilled-doc invariant #15 — the manager tag is NOT
// produced (we don't own the master key for a remote deployment).
//
// Known-deployment lookup: distilled-doc §"Adjacent Seal references"
// → `engine/known-deployments.ts:153-157` carries the
// `mysten-testnet-1` Open-mode independent server. `mainnet`
// intentionally empty (Mysten doesn't ship a public default key
// server on mainnet — production is via Enoki). `devnet`
// intentionally empty.

import { Effect } from 'effect';

import { expectNonEmptyString } from '../../../substrate/runtime/config-validation.ts';
import { sealConfigError } from '../errors.ts';
import type { SealKeyServerEntry, SealKnownResolved } from '../registry-publish.ts';

// ---------------------------------------------------------------------------
// Known-deployment table — distilled-doc reference
// ---------------------------------------------------------------------------

/** Closed set of known deployments. `mainnet` + `devnet` intentionally
 *  null (no public default key server). `testnet` carries the public
 *  key-server URL but `keyServerObjectId` is `null` until a real id is
 *  sourced — `validateLiveInputs` forces the caller to supply
 *  `objectId` explicitly in that case. */
export const KNOWN_DEPLOYMENTS: {
	readonly testnet: {
		readonly keyServerObjectId: string | null;
		readonly keyServerUrl: string;
	};
	readonly mainnet: null;
	readonly devnet: null;
} = {
	testnet: {
		keyServerObjectId: null,
		keyServerUrl: 'https://seal-keyserver.testnet.mystenlabs.com',
	},
	mainnet: null,
	devnet: null,
};

export type KnownNetwork = keyof typeof KNOWN_DEPLOYMENTS;

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

/** Live-mode inputs. Either `network` resolves to a known deployment
 *  OR the user supplies explicit `objectId` + `keyServerUrl`
 *  overrides. Distilled-doc §"Configuration" — the factory throws
 *  synchronously if neither path produces a usable tuple. */
export interface LiveModeInputs {
	readonly name: string;
	readonly network?: KnownNetwork;
	readonly objectId?: string;
	readonly keyServerUrl?: string;
}

// ---------------------------------------------------------------------------
// Resolved
// ---------------------------------------------------------------------------

/** Validate the inputs at the factory boundary. Pure synchronous
 *  function. The plugin `start` body is reserved for Effect-flavored
 *  work; the throw here matches v3's pattern (distilled-doc
 *  §Failure modes). */
export const validateLiveInputs = (
	inputs: LiveModeInputs,
): {
	readonly objectId: string;
	readonly keyServerUrl: string;
} => {
	const fromNetwork =
		inputs.network && KNOWN_DEPLOYMENTS[inputs.network] ? KNOWN_DEPLOYMENTS[inputs.network] : null;
	const objectId = inputs.objectId ?? fromNetwork?.keyServerObjectId;
	const keyServerUrl = inputs.keyServerUrl ?? fromNetwork?.keyServerUrl;
	const message = `seal.live: missing required fields. Pass network ('testnet') or set objectId + keyServerUrl explicitly (got network=${String(
		inputs.network,
	)}, objectId=${String(inputs.objectId)}, keyServerUrl=${String(inputs.keyServerUrl)}).`;
	return {
		objectId: expectNonEmptyString(objectId, {
			field: 'objectId',
			message,
			mkError: sealConfigError,
		}),
		keyServerUrl: expectNonEmptyString(keyServerUrl, {
			field: 'keyServerUrl',
			message,
			mkError: sealConfigError,
		}),
	};
};

// ---------------------------------------------------------------------------
// Mode acquire
// ---------------------------------------------------------------------------

/** Acquire body for the live mode. Validation already ran at the
 *  factory boundary (see `index.ts:buildLivePlugin`); this projects
 *  the validated bundle into the resolved shape. Returns the
 *  read-side handle ONLY (no manager tag — distilled-doc invariant #15). */
export const acquireLive = (inputs: {
	readonly name: string;
	readonly resolved: { readonly objectId: string; readonly keyServerUrl: string };
}): Effect.Effect<SealKnownResolved> =>
	Effect.sync(() => {
		const serverConfigs: ReadonlyArray<SealKeyServerEntry> = [
			{ objectId: inputs.resolved.objectId, weight: 1 },
		];
		return {
			keyServer: {
				serverConfigs,
				keyServerUrl: inputs.resolved.keyServerUrl,
				objectId: inputs.resolved.objectId,
			},
		} satisfies SealKnownResolved;
	});
