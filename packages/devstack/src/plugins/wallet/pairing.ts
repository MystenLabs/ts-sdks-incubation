// Wallet plugin — pairing-token discipline.
//
// What this module owns (15-wallet.md "Token comparison MUST be
// constant-time", "Token MUST live in URL fragment (not query)",
// "Token MUST NOT appear in log lines", "Token file MUST be mode
// 0o600"):
//
//   1. Token generation: 16 random bytes → 32 hex chars.
//   2. Token persistence: file at `<stateRoot>/wallet/token`, mode
//      `0o600`, atomic write.
//   3. Token rehydration: read-existing-or-mint so warm starts +
//      snapshot restore preserve the dev-wallet pairing.
//   4. URL-fragment ↔ Authorization-header bridge: helpers that
//      compose the pair URL (token in fragment) and parse the
//      bearer-prefixed header back to the raw token.
//   5. Constant-time bearer compare: timing-safe equality so a
//      remote attacker can't recover the token byte-by-byte via
//      response-time measurement.
//
// What this module does NOT own:
//
//   - The HTTP server (see `server.ts`).
//   - The CORS / Origin allowlist (see `origin-policy.ts`).
//   - The codegen file (see `codegen.ts`).

import { Effect, FileSystem } from 'effect';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join as joinPath } from 'node:path';

import { atomicWriteFile } from '../../substrate/runtime/atomic-write.ts';
import { redactText, type RedactionRule } from '../../substrate/runtime/observability/index.ts';
import { walletBootError, type WalletBootError } from './errors.ts';
import {
	WALLET_BEARER_PREFIX,
	WALLET_TOKEN_FRAGMENT_KEY,
	WALLET_TOKEN_HEX_LENGTH,
} from './protocol.ts';

// ----------------------------------------------------------------------
// Token shape
// ----------------------------------------------------------------------

/** A pairing token. Branded so it can't be confused with arbitrary
 *  strings at the type level — only this module mints them. */
export type PairingToken = string & { readonly __pairingToken: unique symbol };

/** Token-charset regex: lowercase hex, exactly 32 chars. Reject any
 *  on-disk value that doesn't match (re-mint). */
const TOKEN_RE = /^[0-9a-f]{32}$/;

const asToken = (s: string): PairingToken => s as PairingToken;

// ----------------------------------------------------------------------
// Generation
// ----------------------------------------------------------------------

/** Mint a fresh token. 16 random bytes → 32 hex chars. */
export const mintToken = (): Effect.Effect<PairingToken> =>
	Effect.sync(() => asToken(randomBytes(16).toString('hex')));

// ----------------------------------------------------------------------
// Persistence
// ----------------------------------------------------------------------

/** Resolve the on-disk token path under a state root. The state root
 *  is the substrate path resolver's per-stack `StackPathsService.stackRoot`
 *  (derived from the runtime root + identity); this helper centralises
 *  the layout convention.
 *
 *  Convention: `<stateRoot>/wallet/token` — one token per stack, lives
 *  alongside other per-stack runtime artifacts. */
export const tokenPath = (stateRoot: string): string => joinPath(stateRoot, 'wallet', 'token');

/**
 * Read the on-disk token if it exists and is well-formed; otherwise
 * mint + persist a fresh one via the substrate's atomic-write primitive
 * (mkdir-parent → O_EXCL temp → write → fsync → rename, mode 0o600).
 * Warm starts and snapshot restores both land in the "read existing"
 * branch so a previously-paired dev-wallet keeps working without a
 * re-pair UX.
 */
export const acquirePairingToken = (
	path: string,
): Effect.Effect<PairingToken, WalletBootError, FileSystem.FileSystem> =>
	Effect.gen(function* () {
		// Try to read an existing token.
		const existing = yield* Effect.tryPromise({
			try: async () => {
				try {
					return await readFile(path, 'utf8');
				} catch (err) {
					if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return null;
					throw err;
				}
			},
			catch: (cause) =>
				walletBootError({
					phase: 'read-token',
					message: `read of wallet token file failed at ${path}`,
					hint: 'check filesystem permissions / disk availability',
					cause,
				}),
		});

		if (existing !== null) {
			const trimmed = existing.trim();
			if (TOKEN_RE.test(trimmed)) {
				return asToken(trimmed);
			}
			// Malformed — fall through to mint + overwrite.
			yield* Effect.logWarning('wallet token file is malformed; re-minting').pipe(
				Effect.annotateLogs({
					'wallet.tokenFile': path,
				}),
			);
		}

		// Mint a new one + persist via substrate's atomic-write
		// (mode 0o600). The token survives partial-write failures: the
		// in-memory value is authoritative for the current cycle, and a
		// failed persist surfaces as `write-token` so callers can choose
		// to fail-fast or continue with a transient pairing.
		const token = yield* mintToken();
		const bytes = new TextEncoder().encode(token);
		yield* atomicWriteFile(path, bytes, { mode: 0o600 }).pipe(
			Effect.mapError((cause) =>
				walletBootError({
					phase: 'write-token',
					message: `failed to persist wallet token at ${path}`,
					hint: 'ENOSPC / EROFS / EACCES — boot continues with in-memory token; new pairing required next cycle',
					cause,
				}),
			),
		);

		return token;
	});

// ----------------------------------------------------------------------
// Pair-URL composition (fragment-only)
// ----------------------------------------------------------------------

/**
 * Compose the pair URL the dev-wallet adapter reads.
 *
 * The token rides the URL FRAGMENT (`#token=...`), never a query
 * parameter. Fragments are not sent to servers, so the token can't
 * land in access logs / referrer headers / Sentry breadcrumbs.
 */
export const composePairUrl = (walletUrl: string, token: PairingToken): string =>
	`${walletUrl}/#${WALLET_TOKEN_FRAGMENT_KEY}=${token}`;

/**
 * Inverse — parse the token out of a pair URL fragment. Used by tests +
 * by the dev-wallet adapter (mirrored there because of the workspace-
 * cycle constraint).
 */
export const parsePairUrl = (pairUrl: string): PairingToken | null => {
	const hashIdx = pairUrl.indexOf('#');
	if (hashIdx < 0) return null;
	const fragment = pairUrl.slice(hashIdx + 1);
	const prefix = `${WALLET_TOKEN_FRAGMENT_KEY}=`;
	if (!fragment.startsWith(prefix)) return null;
	const raw = fragment.slice(prefix.length);
	return TOKEN_RE.test(raw) ? asToken(raw) : null;
};

// ----------------------------------------------------------------------
// Authorization-header bridge
// ----------------------------------------------------------------------

/**
 * Parse a raw `Authorization` header value into the bearer token. The
 * dev-wallet adapter copies the token from `url.hash` into the
 * `Authorization: Bearer <token>` header on every request — this
 * helper is the symmetric inverse.
 *
 * Returns `null` on missing / malformed header so the caller can map
 * to the structured `unauthorized` request error.
 */
export const parseBearerHeader = (header: string | undefined): string | null => {
	if (header === undefined) return null;
	if (!header.startsWith(WALLET_BEARER_PREFIX)) return null;
	const raw = header.slice(WALLET_BEARER_PREFIX.length);
	// Don't TOKEN_RE-test here — the constant-time compare against the
	// expected token covers shape mismatch (length-difference shortcut
	// is acceptable since token length is public knowledge).
	return raw.length === WALLET_TOKEN_HEX_LENGTH ? raw : null;
};

// ----------------------------------------------------------------------
// Constant-time compare
// ----------------------------------------------------------------------

/**
 * Constant-time bearer-token compare. The length-mismatch shortcut is
 * intentional — token length is public knowledge (always 32 hex
 * chars), so leaking "wrong length" is not a credential leak. The
 * shortcut also prevents `timingSafeEqual` from throwing on mismatched
 * buffer sizes.
 *
 * Invariant (15-wallet.md "Token comparison MUST be constant-time"):
 * NEVER `===` two tokens. `===` on strings short-circuits at the first
 * mismatching byte, leaking the prefix byte-by-byte via response-time
 * measurement to a remote attacker.
 */
export const safeBearerEquals = (a: string, b: PairingToken | string): boolean => {
	if (a.length !== b.length) return false;
	// `a` is attacker-controlled — a multi-byte UTF-8 codepoint in `a`
	// would inflate `ab.length` past `bb.length` even though
	// `a.length === b.length` passed (string length counts UTF-16 code
	// units, byte length counts UTF-8 bytes). The second length guard
	// stops `timingSafeEqual` from throwing in that case (its contract
	// requires equal-length buffers) and keeps the function total. For
	// the canonical case (`b` is a 32-hex `PairingToken`) the guard is
	// redundant; for the defensive case it prevents a malformed-input
	// throw from leaking up the dispatcher path.
	const ab = Buffer.from(a, 'utf8');
	const bb = Buffer.from(b, 'utf8');
	if (ab.length !== bb.length) return false;
	return timingSafeEqual(ab, bb);
};

// ----------------------------------------------------------------------
// Logging hygiene
// ----------------------------------------------------------------------

const TOKEN_REDACTION_RULE: RedactionRule = {
	kind: 'pattern',
	pattern: /([#?&]token=)[A-Za-z0-9]+/g,
	replacement: '$1<redacted>',
};

/**
 * Redact the token fragment from any URL-shaped string for logging /
 * TUI rendering. Defense-in-depth — the engine's log sink should never
 * see the unredacted pair URL anyway, but this exists for callers that
 * accidentally pass `pairUrl` straight into a log line.
 *
 * This regex covers BOTH the fragment form (`#token=`) and a
 * hypothetical query form so a future config change doesn't silently
 * leak.
 */
export const redactToken = (s: string): string => redactText(s, [TOKEN_REDACTION_RULE]);
