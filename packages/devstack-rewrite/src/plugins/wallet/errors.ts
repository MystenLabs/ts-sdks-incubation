// Wallet plugin — typed errors.
//
// Distilled-doc finding (15-wallet.md "Failure modes"): the wallet's
// failure surface separates BOOT-time errors from REQUEST-time errors.
// Boot errors surface as `WalletBootError` (port allocation, listen
// failure, token-file write); request errors surface as
// `WalletRequestError` (auth, origin, route, body parse, sign-route
// failure). The two channels never mix — request errors flow back to
// the HTTP client as JSON envelopes, boot errors flow up the supervisor
// scope.
//
// Effect v4: plain interface + `_tag` literal discriminator (no
// subclassing). Per-plugin tagged-error convention — the cause walker
// dispatches on `_tag`.

/**
 * Phases for `WalletBootError`. Closed sum — adding a phase means
 * editing this list AND any cause-walker display tables.
 *
 *  - `listen`            : `http.Server.listen` rejected (typically
 *                          EADDRINUSE after port-broker forward-scan, or
 *                          EACCES on a privileged port).
 *  - `allocate-port`     : the supervisor's port broker could not yield
 *                          a free port near the preferred one.
 *  - `read-token`        : the on-disk pairing-token file existed but
 *                          could not be read (EACCES, EIO).
 *  - `write-token`       : the freshly-minted token file could not be
 *                          persisted (ENOSPC, EROFS).
 *  - `bind-account`      : a consumed account tag failed to resolve at
 *                          acquire time (re-thrown with a wallet phase).
 *  - `no-accounts`       : account inference resolved to an empty set.
 */
export type WalletBootPhase =
	| 'listen'
	| 'allocate-port'
	| 'read-token'
	| 'write-token'
	| 'bind-account'
	| 'no-accounts';

/** Boot-time wallet error — raised by the plugin's acquire body. */
export interface WalletBootError {
	readonly _tag: 'WalletBootError';
	readonly phase: WalletBootPhase;
	readonly message: string;
	readonly hint?: string;
	readonly cause?: unknown;
}

export const walletBootError = (parts: Omit<WalletBootError, '_tag'>): WalletBootError => ({
	_tag: 'WalletBootError',
	...parts,
});

/**
 * Phases for `WalletRequestError`. Each maps to an HTTP status the
 * server emits (status code carried explicitly so renderers can keep
 * the mapping in one place rather than re-deriving it).
 *
 *  - `origin-missing`        : 403 — no Origin header on a protected
 *                              route (closes the curl/non-browser
 *                              bypass; mandatory by C12).
 *  - `origin-forbidden`      : 403 — Origin not in the stack-scoped
 *                              allowlist.
 *  - `unauthorized`          : 401 — bearer absent or did not survive
 *                              constant-time compare.
 *  - `route-not-found`       : 404 — `/api/v1/devstack/*` path with no
 *                              handler wired.
 *  - `address-not-found`     : 404 — sign request named an address the
 *                              wallet did not bind.
 *  - `body-invalid`          : 400 — JSON parse, missing required
 *                              field, non-base64 bytes, body >64 KiB.
 *  - `sign-route-failed`     : 500 — the routed `AccountValue` sign
 *                              closure raised an `AccountSignError`.
 */
export type WalletRequestPhase =
	| 'origin-missing'
	| 'origin-forbidden'
	| 'unauthorized'
	| 'route-not-found'
	| 'address-not-found'
	| 'body-invalid'
	| 'sign-route-failed';

/** Request-time wallet error — raised by the in-process HTTP handlers.
 *  Carries the HTTP status the server will write and an optional inner
 *  cause (e.g. an `AccountSignError` for `sign-route-failed`). */
export interface WalletRequestError {
	readonly _tag: 'WalletRequestError';
	readonly phase: WalletRequestPhase;
	readonly httpStatus: number;
	readonly message: string;
	readonly cause?: unknown;
}

export const walletRequestError = (
	parts: Omit<WalletRequestError, '_tag'>,
): WalletRequestError => ({ _tag: 'WalletRequestError', ...parts });

/** Union of every error a wallet caller may encounter. */
export type WalletError = WalletBootError | WalletRequestError;

/** Error tags this plugin contributes — surfaced to the cause walker
 *  via `PluginErrorContribution`. */
export const WALLET_ERROR_TAGS: ReadonlyArray<WalletError['_tag']> = [
	'WalletBootError',
	'WalletRequestError',
] as const;
