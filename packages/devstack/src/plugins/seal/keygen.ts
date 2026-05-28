// Seal plugin — BLS12-381 keygen helpers + master-key redactor.
//
// Distilled-doc invariant (07-seal.md §"Generic artifact-publisher-publish"
// + §Hard requirements #16): the master-key MUST be redacted from any
// stdout/stderr that may surface in a SealError. The redactor lives
// here as the single owner so call sites (`mode/local-keygen.ts`,
// `key-manager.ts`) all funnel through one regex.
//
// The keygen pipeline is REAL — `runtime.runOneShot` against the cargo
// image runs `seal-cli genkey`, captures stdout, parses the BLS hex
// pair. The image itself is the seam (`SEAL_CARGO_IMAGE_OVERRIDE` env
// — see `bootstrap-assets/cargo-image.ts`).

import { Duration, Effect, type Scope } from 'effect';

import type { ContainerRuntime, ImageRef } from '../../contracts/container-runtime.ts';
import { redactText, type RedactionRule } from '../../substrate/runtime/observability/index.ts';
import { sealError, type SealError } from './errors.ts';
import { SealSpans } from './spans.ts';

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
 *  the ArtifactPublisher substrate. */
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

/** Defense-in-depth: any contiguous hex run of 64+ chars is treated as
 *  a possible BLS12-381 master key (32 bytes = 64 hex chars). The
 *  label-based pass catches the canonical `Master key: 0x…` format;
 *  this pass catches stray hex emissions that drop the label (e.g. a
 *  `log::info!("{}", master)` call site upstream that prints only the
 *  hex). Bounded at 64+ to avoid false-positives on shorter hex like
 *  4-byte chain ids or 8-byte object-id prefixes; legitimate Sui
 *  object ids are 32 bytes (64 hex chars) and would also trip the
 *  rule — acceptable, since a redacted object id is a tractable
 *  diagnostic regression while a leaked master key is not.
 *
 *  Boundary shape: negative lookbehind/lookahead against the hex class
 *  itself (NOT `\b`). The `\b` form had a known gap — `0x<hex>` and
 *  `<word-prefix>0x<hex>` failed to match because `0` and `x` are
 *  both `\w` characters, so `\b` couldn't anchor at the start of the
 *  hex run. The lookbehind form starts the match anywhere not
 *  preceded by a hex character, so an adversarial concat like
 *  `...key0xdeadbeef…` redacts the hex run starting right after the
 *  non-hex `x`. */
const HIGH_ENTROPY_HEX_RE = /(?<![0-9a-fA-F])[0-9a-fA-F]{64,}(?![0-9a-fA-F])/g;

const MASTER_KEY_REDACTION_RULES: ReadonlyArray<RedactionRule> = [
	// Order matters: redact the labeled line first (replaces the whole
	// line including the hex), then the standalone-hex pass picks up
	// anything left over. Because the first pass replaces the full line
	// with a fixed literal containing no hex, the second pass cannot
	// double-replace.
	{
		kind: 'pattern',
		pattern: MASTER_KEY_LINE_RE,
		replacement: '[REDACTED master key]',
	},
	{
		kind: 'pattern',
		pattern: HIGH_ENTROPY_HEX_RE,
		replacement: '<REDACTED-HEX-RUN>',
	},
];

/** Replace any line containing `master_key` / `master-key` / `masterkey`
 *  (case-insensitive) with `[REDACTED master key]`, AND any standalone
 *  hex run of 64+ chars with `<REDACTED-HEX-RUN>`. Used at every site
 *  that may surface stdout/stderr from `seal-cli`. */
export const redactMasterKey = (s: string): string => redactText(s, MASTER_KEY_REDACTION_RULES);

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
	// Bounded widths — BLS12-381 master is 32 bytes (64 hex chars);
	// public key is 96 bytes uncompressed G2 (192 hex chars). The
	// trailing `\b` prevents a greedy slurp if the upstream binary
	// ever prints adjacent hex on the same line.
	const masterMatch = stdout.match(/Master key:\s*(0x)?([0-9a-fA-F]{64})\b/);
	const publicMatch = stdout.match(/Public key:\s*(0x)?([0-9a-fA-F]{192})\b/);
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
			attributes: { [SealSpans.name]: name },
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
