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
import { sealConfigError, sealError, type SealAnyError } from '../errors.ts';
import type { SealKeyServerEntry, SealKnownResolved } from '../registry-publish.ts';

// ---------------------------------------------------------------------------
// Known-deployment table — distilled-doc reference
// ---------------------------------------------------------------------------

/** Closed set of known deployments. `mainnet` + `devnet` intentionally
 *  null (distilled-doc cross-ref). v2 plans should canonicalize this
 *  table — for now we mirror v3's structure. */
export const KNOWN_DEPLOYMENTS = {
	testnet: {
		keyServerObjectId:
			'0x000000000000000000000000000000000000000000000000000000000000mysten' as string,
		keyServerUrl: 'https://seal-keyserver.testnet.mystenlabs.com',
	},
	mainnet: null,
	devnet: null,
} as const;

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
 *  function — the substrate's `defineNodePlugin.acquire` is
 *  exclusively for Effect-flavored work; the throw here matches
 *  v3's pattern (distilled-doc §Failure modes). */
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

/** Acquire body for the live mode. Returns the read-side handle
 *  ONLY (no manager tag — distilled-doc invariant #15). */
export const acquireLive = (
	inputs: LiveModeInputs,
): Effect.Effect<SealKnownResolved, SealAnyError> =>
	Effect.gen(function* () {
		// Validation runs at the factory layer; here we trust the
		// validated fields. The substrate's registry publishes happen
		// at the orchestrator layer (manifest emitter walks the
		// codegen contributions); this body just returns the resolved
		// value.
		let resolved: { readonly objectId: string; readonly keyServerUrl: string };
		try {
			resolved = validateLiveInputs(inputs);
		} catch (err) {
			if (
				typeof err === 'object' &&
				err !== null &&
				'_tag' in err &&
				err._tag === 'SealConfigError'
			) {
				return yield* Effect.fail(err as SealAnyError);
			}
			return yield* Effect.fail(
				sealError('seal', {
					name: inputs.name,
					message: err instanceof Error ? err.message : String(err),
					cause: err,
				}),
			);
		}
		const serverConfigs: ReadonlyArray<SealKeyServerEntry> = [
			{ objectId: resolved.objectId, weight: 1 },
		];
		return {
			keyServer: {
				serverConfigs,
				keyServerUrl: resolved.keyServerUrl,
				objectId: resolved.objectId,
			},
		} satisfies SealKnownResolved;
	});
