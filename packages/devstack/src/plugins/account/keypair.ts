// Account plugin — keypair generation + scheme normalization helpers.
//
// Distilled-doc finding (12-account.md "Scheme normalization"
// invariant): scheme surfaced to consumers MUST be lowercased at the
// account boundary. Mixed-case from the SDK leaks into manifest
// serialization and on-chain Move type matching if not converted. We
// pin the canonical lowercased union at this module's boundary and
// every variant resolver dumps through `normalizeScheme` before
// producing the resolved value.
//
// Distilled-doc opportunity ("Co-locate the canonical Account-value
// Schema with the canonical type"): the canonical signature scheme
// union lives here, NOT next to the factory, so future Schema sits
// alongside the type.

import { Effect } from 'effect';

import { decodeSuiPrivateKey, encodeSuiPrivateKey } from '@mysten/sui/cryptography';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';

import {
	accountAcquireError,
	type AccountAcquireError,
	type AccountVariantKind,
} from './errors.ts';

/** Lowercased signature scheme — the canonical wire form. The SDK
 *  occasionally hands us `'ED25519'` / `'Secp256k1'`; the boundary
 *  conversion lives in `normalizeScheme`. */
export type SignatureScheme = 'ed25519' | 'secp256k1' | 'secp256r1';

/** Resolved keypair shape — the variant resolvers all funnel into
 *  this so the funding + register passes are variant-agnostic.
 *
 *  Note: impersonation accounts do NOT produce a `Keypair`; they
 *  produce a `SyntheticImpersonationSigner` (see
 *  `variants/impersonate.ts`). The discriminator lives on the
 *  resolved `AccountValue` (architecture: distilled doc opportunity
 *  "Tighten the resolved-account type"). */
export interface ResolvedKeypair {
	readonly address: string;
	readonly scheme: SignatureScheme;
	readonly publicKey: Uint8Array;
	/** Opaque signer handle — typed loosely here because the four
	 *  real variants (ed25519/secp256k1/secp256r1 + bring-your-own
	 *  Signer) share no narrow TS type beyond `Signer`. The wallet /
	 *  sign-and-execute capability narrows downstream. */
	readonly signer: unknown;
	/** Bech32-encoded secret. Only present for ephemeral / inline /
	 *  env / keystore variants — `null` for `signer` (we never ask
	 *  for it) and `impersonate` (no secret exists). */
	readonly bech32Secret: string | null;
}

/** Normalize the SDK's mixed-case scheme to the lowercased wire form.
 *  Unknown schemes surface as a typed acquisition error (distilled
 *  doc: "Unsupported signature scheme (multisig / zklogin / passkey)
 *  — currently a raw throw; should be promoted to the typed-error
 *  channel"). */
export const normalizeScheme = (
	raw: string,
	accountName: string,
	variant: AccountVariantKind,
): Effect.Effect<SignatureScheme, AccountAcquireError> => {
	const lower = raw.toLowerCase();
	if (lower === 'ed25519' || lower === 'secp256k1' || lower === 'secp256r1') {
		return Effect.succeed(lower);
	}
	return Effect.fail(
		accountAcquireError({
			phase: 'unsupported-scheme',
			accountName,
			variant,
			message: `Account '${accountName}': unsupported signature scheme '${raw}'. devstack supports ed25519, secp256k1, secp256r1.`,
			hint: 'Multisig, zklogin, and passkey schemes are not yet supported via the Account plugin — bring your own Signer via {kind:"signer"}.',
		}),
	);
};

/** Generate a fresh Ed25519 keypair. The default for the
 *  `ephemeral` variant.
 *
 *  Architecture-distilled invariant: schemes other than Ed25519
 *  must be loaded via keystore/env/inline; we never generate
 *  Secp256* keys from scratch. */
export const generateEd25519Keypair = (
	accountName: string,
): Effect.Effect<ResolvedKeypair, AccountAcquireError> =>
	Effect.try({
		try: () => {
			const kp = Ed25519Keypair.generate();
			return resolvedKeypairFromEd25519(kp);
		},
		catch: (cause): AccountAcquireError =>
			accountAcquireError({
				phase: 'generate-keypair',
				accountName,
				variant: 'ephemeral',
				message: `Account '${accountName}': Ed25519Keypair.generate() threw.`,
				cause,
			}),
	});

/** Decode a bech32 `suiprivkey1...` string into a resolved keypair.
 *  Used by the inline / env / keystore variants. */
export const decodeBech32Secret = (
	bech32: string,
	accountName: string,
	variant: AccountVariantKind,
): Effect.Effect<ResolvedKeypair, AccountAcquireError> =>
	Effect.gen(function* () {
		const parsed = yield* Effect.try({
			try: () => decodeSuiPrivateKey(bech32),
			// Secret-leak guard: the thrown error from `decodeSuiPrivateKey`
			// can echo the rejected bech32 string back in its message, so we
			// deliberately DROP the raw `cause`. The typed `message` already
			// names the failure; a malformed-secret error carries no
			// actionable diagnostic beyond "it was malformed".
			catch: (): AccountAcquireError =>
				accountAcquireError({
					phase: 'decode-inline',
					accountName,
					variant,
					message: `Account '${accountName}': decodeSuiPrivateKey() rejected the supplied bech32 secret.`,
				}),
		});
		const scheme = yield* normalizeScheme(parsed.scheme, accountName, variant);
		if (scheme !== 'ed25519') {
			// Architecture-distilled: today we only construct Ed25519 here.
			// Secp256k1 / Secp256r1 paths land when the SDK's per-scheme
			// Keypair classes are wired in; the typed-error channel keeps
			// the failure actionable until then.
			return yield* Effect.fail(
				accountAcquireError({
					phase: 'unsupported-scheme',
					accountName,
					variant,
					message: `Account '${accountName}': scheme '${scheme}' is not yet wired for the ${variant} variant.`,
					hint: 'Wire the matching @mysten/sui/keypairs/<scheme> import next to the Ed25519 path.',
				}),
			);
		}
		return yield* Effect.try({
			try: () => {
				const kp = Ed25519Keypair.fromSecretKey(parsed.secretKey);
				return resolvedKeypairFromEd25519(kp);
			},
			// Secret-leak guard: `fromSecretKey` can echo the decoded
			// secret-key bytes in its error — DROP the raw `cause`.
			catch: (): AccountAcquireError =>
				accountAcquireError({
					phase: 'decode-inline',
					accountName,
					variant,
					message: `Account '${accountName}': Ed25519Keypair.fromSecretKey() rejected the decoded secret.`,
				}),
		});
	});

/** Build a `ResolvedKeypair` view from a raw Ed25519 secret-key
 *  byte array. Used by the inline-bytes path (`variants/inline.ts`
 *  Uint8Array branch). */
export const resolvedKeypairFromEd25519Bytes = (
	secretKey: Uint8Array,
	accountName: string,
	variant: AccountVariantKind,
): Effect.Effect<ResolvedKeypair, AccountAcquireError> =>
	Effect.try({
		try: () => {
			const kp = Ed25519Keypair.fromSecretKey(secretKey);
			return resolvedKeypairFromEd25519(kp);
		},
		// Secret-leak guard: `fromSecretKey` can echo the raw secret-key
		// bytes in its error — DROP the raw `cause`. (Mirrors the
		// bech32 path in `decodeBech32Secret`.)
		catch: (): AccountAcquireError =>
			accountAcquireError({
				phase: 'decode-inline',
				accountName,
				variant,
				message: `Account '${accountName}': Ed25519Keypair.fromSecretKey() rejected the supplied raw bytes.`,
			}),
	});

/** Encode a 32-byte secret key as a bech32 `suiprivkey1...` string
 *  for the canonical wire form. Re-exported because the
 *  `variants/inline.ts` Uint8Array branch needs it. */
export const encodeEd25519Bech32 = (bytes: Uint8Array): string =>
	encodeSuiPrivateKey(bytes, 'ED25519');

const resolvedKeypairFromEd25519 = (kp: Ed25519Keypair): ResolvedKeypair => ({
	address: kp.toSuiAddress(),
	scheme: 'ed25519',
	publicKey: kp.getPublicKey().toRawBytes(),
	signer: kp,
	bech32Secret: kp.getSecretKey(),
});
