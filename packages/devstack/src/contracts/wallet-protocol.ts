// Wallet wire-protocol constants — name-blind substrate contract.
//
// These are the PURE wire-protocol invariants shared across layers:
// HTTP path strings, the protocol prefix gate, header/token constants,
// and the canonical routed-endpoint name/key. They carry no runtime,
// Effect, or service dependencies — only string/number literals.
//
// Lifted here (ARCHITECTURE.md § Layer table) because L5 build
// integrations (`build-integrations/runtime/wallet-paths.ts` and the
// Playwright/vitest helpers) need them but MUST NOT import L2 plugin
// modules — there is no L5→L0–L3 carve-out. STYLE_GUIDE §7: shared
// cross-layer shapes that no single layer should own live in
// `src/contracts/`; plugin barrels re-export for ergonomics.
//
// One decl per file, no `contracts/index.ts` barrel (STYLE_GUIDE §8 /
// §199): package-internal callers import this module directly; the
// public root barrel re-exports the wallet-plugin barrel, which in
// turn re-exports from here, so the public value/type identity is
// unchanged.
//
// The wallet plugin's `protocol.ts` / `routable.ts` re-export these so
// plugin-internal callers keep their current import sites. The Schema-
// based request/response envelopes stay in `protocol.ts` (they drag in
// `effect`'s Schema runtime and are not needed by the L5 surfaces).

// ----------------------------------------------------------------------
// Path constants
// ----------------------------------------------------------------------

/**
 * Canonical path constants under the `/api/v1/devstack/*` prefix.
 *
 * The wire protocol carries no fork-control (`FORK_*`) routes. When the
 * fork-control surface is wired, those routes will be added (and the
 * dev-wallet adapter shipped together). No half-done stubs.
 */
export const WalletHttpPath = {
	HEALTH: '/api/v1/devstack/health',
	ACCOUNTS: '/api/v1/devstack/accounts',
	SIGN_TRANSACTION: '/api/v1/devstack/sign-transaction',
	SIGN_PERSONAL_MESSAGE: '/api/v1/devstack/sign-personal-message',
} as const;

export type WalletHttpPathValue = (typeof WalletHttpPath)[keyof typeof WalletHttpPath];

/** Prefix gate: ANY path under this prefix is treated as protocol traffic
 *  (and subject to mandatory Origin + bearer); anything else is a flat
 *  404. */
export const WALLET_PROTOCOL_PREFIX = '/api/v1/devstack/' as const;

// ----------------------------------------------------------------------
// Header / token constants (shared so the dev-wallet adapter doesn't
// open-code the same strings).
// ----------------------------------------------------------------------

export const WALLET_AUTH_HEADER = 'authorization' as const;
export const WALLET_BEARER_PREFIX = 'Bearer ' as const;

/** URL-fragment key the pair-URL carries the token under
 *  (`<wallet-url>/#token=<32-hex>`). Fragments are not sent to the
 *  server, so the token never appears in access logs / referrers. */
export const WALLET_TOKEN_FRAGMENT_KEY = 'token' as const;

/** Constant carried token byte length (16 random bytes → 32 hex chars).
 *  The on-disk token file is rejected + re-minted if it doesn't match. */
export const WALLET_TOKEN_HEX_LENGTH = 32 as const;

// ----------------------------------------------------------------------
// Routed-endpoint identity
// ----------------------------------------------------------------------

/** Canonical endpoint name. The router orchestrator surfaces this in
 *  the manifest under `endpoints['wallet-app']`; downstream consumers
 *  (codegen, TUI, doctor) read it by this key.
 *
 *  A stable key so downstream consumers don't break. */
export const WALLET_ENDPOINT_NAME = 'wallet-app' as const;

/** Conventional short endpoint key for the wallet plugin. Matches the
 *  substrate's `EndpointKey` brand. Build integrations (Playwright,
 *  vitest helpers) and the conventional-routes alias table look the
 *  endpoint up under this key; the substrate's alias resolver folds
 *  `'wallet'` → `WALLET_ENDPOINT_NAME` (`'wallet-app'`) before
 *  consulting the manifest.
 *
 *  Paired with the canonical name so both stay in lockstep when the
 *  plugin's HTTP server is renamed; the L5 conventional-routes table
 *  consumes the same constant so there is exactly one source of
 *  truth. */
export const WALLET_ENDPOINT_KEY = 'wallet' as const;
