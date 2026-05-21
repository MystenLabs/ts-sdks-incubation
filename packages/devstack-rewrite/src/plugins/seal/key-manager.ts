// Seal plugin — master-key staging + rotate.
//
// Distilled-doc invariant #23: the `R` channel on
// `SealKeyManager.rotate` MUST be `never`. The acquire body
// captures the substrate services (ChildProcessSpawner, Identity,
// ContainerRuntime) at acquire-time and pre-provides them via
// `Effect.provideService` so the surfaced `rotate` is
// `Effect<void, SealError>`.
//
// This file declares the user-facing `SealKeyManager` shape; the
// rotate body is supplied by the caller (mode/local-keygen.ts) as
// a pre-provided closure.

import { Effect } from 'effect';

import { sealError, type SealError } from './errors.ts';

// ---------------------------------------------------------------------------
// User-facing shape — distilled doc §"SealKeyManager interface"
// ---------------------------------------------------------------------------

/** Local-only admin handle. Produced by the `localKeygen` mode ONLY
 *  (distilled-doc invariant #15 — known-deployment modes do NOT
 *  produce a manager, since we don't own the master key).
 *
 *  Fields:
 *   - `masterKeyEnvFile` — absolute path to the 0o600 env-file
 *     (snapshot-survived).
 *   - `rotate` — re-derive the BLS keypair, register a fresh
 *     on-chain `KeyServer`, restart the container. NOT a hot-swap
 *     (callers that captured the read-side tag before rotate hold
 *     pre-rotation values until a hot-restart). */
export interface SealKeyManager {
	readonly masterKeyEnvFile: string;
	readonly rotate: Effect.Effect<void, SealError>;
}

// ---------------------------------------------------------------------------
// makeKeyManager — pre-provides the substrate services
// ---------------------------------------------------------------------------

/** Inputs the manager closes over. The caller (mode/local-keygen.ts)
 *  has already captured the substrate services AND the per-instance
 *  context (name, signer, image, etc.); this helper just assembles
 *  the consumer-facing shape with `rotate` bound. */
export interface MakeKeyManagerInputs {
	readonly name: string;
	readonly masterKeyEnvFile: string;
	/** The rotate body, with services already provided. Distilled-doc
	 *  invariant #23 — `R = never` on the consumer-facing surface. */
	readonly rotateImpl: Effect.Effect<void, SealError>;
}

export const makeKeyManager = (inputs: MakeKeyManagerInputs): SealKeyManager => ({
	masterKeyEnvFile: inputs.masterKeyEnvFile,
	rotate: inputs.rotateImpl,
});

// ---------------------------------------------------------------------------
// Rotate body — not implemented in this branch
// ---------------------------------------------------------------------------

/** The full rotate pipeline (regenerate keypair → register new
 *  on-chain `KeyServer` object → re-render config + env-file →
 *  restart container → re-probe `/health` → atomically update the
 *  state-store cache) is not implemented in this branch. The
 *  rotateImpl placeholder fails-closed with a typed `rotate`-phase
 *  error so callers see an actionable failure rather than silently
 *  succeeding. */
export const stubRotate = (name: string): Effect.Effect<void, SealError> =>
	Effect.fail(
		sealError('rotate', {
			name,
			message: 'seal.key-manager: rotate is not implemented in this branch',
		}),
	);
