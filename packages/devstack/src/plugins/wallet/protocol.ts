// Wallet plugin — wire-level protocol.
//
// This file is the ONE cross-boundary contract between the devstack-
// side HTTP server (this plugin) and the browser-side adapter (the
// `dev-wallet` package). The browser-side adapter MUST be kept in
// lock-step with these schemas; today that's enforced by a mirror in
// `dev-wallet/src/adapters/devstack-paths.ts` + a byte-equality test.
//
// Distilled-doc opportunity (15-wallet.md "Acyclic-edge duplication"):
// the duplication exists because devstack peer-deps on dev-wallet (for
// codegen output) and a reverse edge would close a workspace cycle.
// Per the task's architecture-revision flag: the long-term fix is to
// hoist this file into a third tiny package (e.g.
// `@mysten-incubation/devstack-wallet-protocol`) consumed by BOTH
// sides. See `## Architecture-doc revisions` in the report.
//
// Canonical envelope choice (15-wallet.md "Asymmetric sign-response
// field names" + "Dual field-name acceptance"):
//
//   - Sign endpoints accept `{ address, bytes }` (always `bytes`, never
//     `txBytes` or `messageBytes`).
//   - Sign endpoints respond `{ bytes, signature }` (always those two
//     names; never `txBytes` / `suiSignature`).
//
// This mirrors `@mysten/sui`'s `Signer.signTransaction` /
// `signPersonalMessage` return shape exactly, eliminating the asymmetry
// the legacy server carried. Per the memory note "no compat for
// never-cases" — devstack is unreleased, no migration burden.
//
// Effect v4 Schema is the validator. Each request/response is a
// Schema.Struct; handlers `Schema.decodeUnknown(...)` the body and
// `catchTag('ParseError', ...)` into a `body-invalid` request error.

import { Schema } from 'effect';

// Pure wire constants live in the name-blind contract so L5 build
// integrations can consume them without importing this L2 plugin
// module; re-exported here so plugin-internal callers keep their
// current import sites.
export {
	WalletHttpPath,
	WALLET_PROTOCOL_PREFIX,
	WALLET_AUTH_HEADER,
	WALLET_BEARER_PREFIX,
	WALLET_TOKEN_FRAGMENT_KEY,
	WALLET_TOKEN_HEX_LENGTH,
	type WalletHttpPathValue,
} from '../../contracts/wallet-protocol.ts';

// ----------------------------------------------------------------------
// Shared primitives
// ----------------------------------------------------------------------

/**
 * Sui address — `0x` + 64 hex chars. Schema-validated so a typo or
 * truncated address surfaces as a structured `body-invalid` request
 * error rather than a confusing `address-not-found` (no account bound
 * at the address would be the same shape if we didn't validate).
 */
export const SuiAddressSchema = Schema.String.check(Schema.isPattern(/^0x[0-9a-fA-F]{64}$/));

/** Base64-encoded bytes — string-typed at the wire (we keep base64 over
 *  the cross-boundary; the server decodes with `Uint8Array.fromBase64`
 *  or equivalent before handing to the Account sign closures). */
export const Base64Schema = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9+/]*={0,2}$/));

/** Signature scheme discriminator surfaced on `/accounts`. Mirrors the
 *  `AccountValue.scheme` shape from the account plugin. */
export const SignatureSchemeSchema = Schema.Union([
	Schema.Literal('ed25519'),
	Schema.Literal('secp256k1'),
	Schema.Literal('secp256r1'),
]);

/** Account-source discriminator. `'impersonate'` accounts cannot
 *  satisfy `signTransaction` / `signPersonalMessage` — fork-admin
 *  surfaces (not part of this protocol today) are the only sensible
 *  consumers. */
export const AccountSourceSchema = Schema.Union([
	Schema.Literal('real'),
	Schema.Literal('impersonate'),
]);

// ----------------------------------------------------------------------
// Response envelopes (200)
// ----------------------------------------------------------------------

export const HealthResponseSchema = Schema.Struct({
	ok: Schema.Literal(true),
});
export type HealthResponse = Schema.Schema.Type<typeof HealthResponseSchema>;

export const AccountSummarySchema = Schema.Struct({
	name: Schema.String,
	address: SuiAddressSchema,
	scheme: SignatureSchemeSchema,
	/** Base64-encoded `publicKey`. Impersonation accounts publish a
	 *  zero-length string here — consumers branch on `source`, not on
	 *  publicKey emptiness. */
	publicKey: Base64Schema,
	source: AccountSourceSchema,
});
export type AccountSummary = Schema.Schema.Type<typeof AccountSummarySchema>;

export const AccountsResponseSchema = Schema.Struct({
	accounts: Schema.Array(AccountSummarySchema),
});
export type AccountsResponse = Schema.Schema.Type<typeof AccountsResponseSchema>;

// ----------------------------------------------------------------------
// Sign endpoints — request + response
// ----------------------------------------------------------------------

/** Canonical sign request — same shape for transaction and personal-
 *  message routes. `bytes` is the only payload key (no `txBytes`,
 *  `message`, or `messageBytes` aliases). */
export const SignRequestSchema = Schema.Struct({
	address: SuiAddressSchema,
	bytes: Base64Schema,
});
export type SignRequest = Schema.Schema.Type<typeof SignRequestSchema>;

/** Canonical sign response — same shape for transaction and personal-
 *  message routes. Matches `@mysten/sui`'s `Signer` return shape
 *  byte-for-byte. */
export const SignResponseSchema = Schema.Struct({
	bytes: Base64Schema,
	signature: Schema.String,
});
export type SignResponse = Schema.Schema.Type<typeof SignResponseSchema>;

// ----------------------------------------------------------------------
// Error envelope
// ----------------------------------------------------------------------

/** Error response body. The HTTP status carries the broad classification
 *  (400/401/403/404/500); `code` carries the narrow phase so callers
 *  can branch programmatically. */
export const ErrorResponseSchema = Schema.Struct({
	error: Schema.String,
	code: Schema.String,
});
export type ErrorResponse = Schema.Schema.Type<typeof ErrorResponseSchema>;

// Header / token constants are re-exported above from
// `../../contracts/wallet-protocol.ts`.
