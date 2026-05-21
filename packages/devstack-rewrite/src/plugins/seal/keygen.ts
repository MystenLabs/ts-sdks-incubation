// Seal plugin — BLS12-381 keygen helpers + master-key redactor.
//
// Distilled-doc invariant (07-seal.md §"Generic on-chain-artifact-publish"
// + §Hard requirements #16): the master-key MUST be redacted from any
// stdout/stderr that may surface in a SealError. The redactor lives
// here as the single owner so call sites (`mode/local-keygen.ts`,
// `key-manager.ts`) all funnel through one regex.
//
// The keygen pipeline is REAL — `runtime.runOneShot` against the cargo
// image runs `seal-cli genkey`, captures stdout, parses the BLS hex
// pair. The image itself is the seam (`SEAL_CARGO_IMAGE_OVERRIDE` env
// — see `lifted-siblings/cargo-image.ts`).

import { Duration, Effect, type Scope } from 'effect';

import type { ContainerRuntime, ImageRef } from '../../contracts/container-runtime.ts';
import { sealError, type SealError } from './errors.ts';

// ---------------------------------------------------------------------------
// Constants — mirror v3 (`seal/internal.ts:115-149`)
// ---------------------------------------------------------------------------

/** Entrypoint binary inside the seal image. */
export const SEAL_KEYGEN_ENTRYPOINT = 'seal-cli';

/** Args for the keygen one-shot. */
export const SEAL_KEYGEN_ARGS = ['genkey'] as const;

/** Default master-key env-file basename inside `runtime/seal/`. */
export const MASTER_KEY_ENVFILE_BASENAME = 'master-key.env';

/** Default key-server config yaml basename inside `runtime/seal/`. */
export const KEY_SERVER_CONFIG_BASENAME = 'key-server-config.yaml';

/** Wall-clock timeout for the keygen one-shot. BLS12-381 keygen is
 *  small — under 1s. 30s ceiling absorbs container startup overhead
 *  on slow CI runners. */
const KEYGEN_TIMEOUT_MS = 30_000;

// ---------------------------------------------------------------------------
// PersistedBlsKeypair — the cache-stored shape
// ---------------------------------------------------------------------------

/** Two hex blobs round-tripped through the substrate StateStore. The
 *  master key is the secret; the public key is on-chain in the
 *  registered `KeyServer` object. Distilled-doc §"Persistence model"
 *  + §Hard requirements #5 — chainId is folded into the cache key by
 *  the OnChainArtifactPublisher substrate. */
export interface PersistedBlsKeypair {
	readonly masterKey: string;
	readonly publicKey: string;
}

// ---------------------------------------------------------------------------
// Redaction — distilled-doc invariant #16
// ---------------------------------------------------------------------------

/** Case-insensitive line-level pattern matching any `master[_-]?key`
 *  mention. Mirrors v3's `MASTER_KEY_LINE_RE` (`seal/internal.ts:1343`). */
const MASTER_KEY_LINE_RE = /^.*master[_\- ]?key.*$/gim;

/** Replace any line containing `master_key` / `master-key` / `masterkey`
 *  (case-insensitive) with the literal `[REDACTED master key]`. Used at
 *  every site that may surface stdout/stderr from `seal-cli`.
 *
 *  Distilled-doc opportunity #16: this redactor is a candidate for
 *  generalization into a shared `redactSecrets(stdout, patterns)`
 *  substrate primitive. v2 plans should fold it into the
 *  observability layer once a second consumer (walrus, postgres)
 *  needs analogous redaction. */
export const redactMasterKey = (s: string): string =>
	s.replace(MASTER_KEY_LINE_RE, '[REDACTED master key]');

// ---------------------------------------------------------------------------
// Output parser — distilled-doc §"Helpers"
// ---------------------------------------------------------------------------

/** Parse `Master key:` / `Public key:` hex lines from `seal-cli genkey`
 *  stdout. Hex prefix may or may not include `0x` (we strip it).
 *
 *  Returns a typed `PersistedBlsKeypair` on success, or fails with a
 *  `SealError({phase: 'keygen'})` carrying the REDACTED tail of the
 *  stdout so a parser drift doesn't leak the master key into logs. */
export const parseSealKeygenOutput = (
	stdout: string,
	name: string,
): Effect.Effect<PersistedBlsKeypair, SealError> => {
	const stripHex = (s: string): string => (s.startsWith('0x') ? s.slice(2) : s);
	const masterMatch = stdout.match(/Master key:\s*(0x)?([0-9a-fA-F]+)/);
	const publicMatch = stdout.match(/Public key:\s*(0x)?([0-9a-fA-F]+)/);
	if (!masterMatch || !publicMatch) {
		return Effect.fail(
			sealError('keygen', {
				name,
				message:
					'seal.keygen: could not parse seal-cli genkey output (Master key: / Public key: lines missing)',
				stdout: redactMasterKey(stdout),
			}),
		);
	}
	return Effect.succeed({
		masterKey: stripHex(masterMatch[2]!),
		publicKey: stripHex(publicMatch[2]!),
	} satisfies PersistedBlsKeypair);
};

// ---------------------------------------------------------------------------
// Hex decode — minimal helper
// ---------------------------------------------------------------------------

/** Decode hex → bytes. Tolerates leading `0x`; fails on odd length. */
export const decodeHex = (hex: string): Uint8Array => {
	const stripped = hex.startsWith('0x') ? hex.slice(2) : hex;
	if (stripped.length % 2 !== 0) {
		throw new Error('decodeHex: odd-length hex string');
	}
	const out = new Uint8Array(stripped.length / 2);
	for (let i = 0; i < out.length; i++) {
		out[i] = parseInt(stripped.slice(i * 2, i * 2 + 2), 16);
	}
	return out;
};

// ---------------------------------------------------------------------------
// Real keygen one-shot
// ---------------------------------------------------------------------------

/** Run `seal-cli genkey` inside the cargo-built seal image and
 *  parse the BLS12-381 master + public keys.
 *
 *  Implementation:
 *   1. `runtime.runOneShot({ image, entrypoint: 'seal-cli', argv:
 *      ['genkey'], timeoutMillis: 30s })` — fresh `docker run --rm`.
 *   2. Promote non-zero exit to typed SealError with REDACTED tails.
 *   3. Parse stdout via `parseSealKeygenOutput`.
 *
 *  Distilled-doc invariant #16 — every stdout/stderr capture site
 *  passes through `redactMasterKey` BEFORE landing in the error. The
 *  parser handles the success-path; the failure path does its own
 *  redact at the raise site. */
export const runSealKeygen = (
	runtime: ContainerRuntime,
	name: string,
	image: ImageRef,
): Effect.Effect<PersistedBlsKeypair, SealError, Scope.Scope> =>
	Effect.gen(function* () {
		const result = yield* runtime
			.runOneShot({
				image,
				entrypoint: SEAL_KEYGEN_ENTRYPOINT,
				argv: SEAL_KEYGEN_ARGS,
				timeoutMillis: KEYGEN_TIMEOUT_MS,
			})
			.pipe(
				Effect.catch((cause) =>
					Effect.fail(
						sealError('keygen', {
							name,
							message: `seal-cli genkey one-shot failed: ${cause.reason}: ${cause.detail}`,
							cause,
						}),
					),
				),
			);

		if (result.exitCode !== 0) {
			return yield* Effect.fail(
				sealError('keygen', {
					name,
					message: `seal-cli genkey exited with code ${result.exitCode}`,
					exitCode: result.exitCode,
					// Defense-in-depth — the redactor handles success-path
					// output (where the key is the parsed value) but the
					// failure path's stdout MAY also carry the key, e.g.
					// when stderr says "wrote master key to <log>".
					stdout: redactMasterKey(result.stdout),
					stderr: redactMasterKey(result.stderr),
				}),
			);
		}

		return yield* parseSealKeygenOutput(result.stdout, name);
	}).pipe(
		Effect.withSpan('devstack.plugin.seal.keygen.oneShot', {
			attributes: { 'seal.name': name },
		}),
		Effect.timeoutOrElse({
			duration: Duration.millis(KEYGEN_TIMEOUT_MS + 5_000),
			orElse: () =>
				Effect.fail(
					sealError('keygen', {
						name,
						message: `seal.keygen: outer timeout ${KEYGEN_TIMEOUT_MS}ms exceeded`,
					}),
				),
		}),
	);
