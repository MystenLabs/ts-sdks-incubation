// Seal plugin — master-key staging.

// ---------------------------------------------------------------------------
// User-facing shape — distilled doc §"SealKeyManager interface"
// ---------------------------------------------------------------------------

/** Local-only admin handle. Produced by the `localKeygen` mode ONLY
 *  (distilled-doc invariant #15 — known-deployment modes do NOT
 *  produce a manager, since we don't own the master key).
 *
 *  Fields:
 *   - `masterKeyEnvFile` — absolute path to the 0o600 env-file
 *     (snapshot-survived). */
export interface SealKeyManager {
	readonly masterKeyEnvFile: string;
}

// ---------------------------------------------------------------------------
// makeKeyManager — pre-provides the substrate services
// ---------------------------------------------------------------------------

/** Inputs the manager closes over. The caller (mode/local-keygen.ts)
 *  has already captured the substrate services AND the per-instance
 *  context (name, signer, image, etc.); this helper just assembles
 *  the consumer-facing shape. */
export interface MakeKeyManagerInputs {
	readonly masterKeyEnvFile: string;
}

export const makeKeyManager = (inputs: MakeKeyManagerInputs): SealKeyManager => ({
	masterKeyEnvFile: inputs.masterKeyEnvFile,
});
