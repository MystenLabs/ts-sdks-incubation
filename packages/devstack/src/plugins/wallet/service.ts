// Wallet plugin — main acquire Effect.
//
// What this file does (15-wallet.md §Lifecycle, Startup ordered):
//
//   1. Resolve each consumed account tag and key the AccountValues by
//      address (load-bearing: sign endpoints look up by address).
//   2. Allocate a port via the substrate's `PortBrokerService`.
//   3. Mint or rehydrate the pairing token (read-existing-or-mint at
//      `<stateRoot>/wallet/token`, mode 0o600) via the substrate's
//      `atomicWriteFile`.
//   4. Resolve the stack-scoped origin allowlist via
//      `origin-policy.ts`.
//   5. Start the in-process HTTP server.
//   6. Compose the wallet URL + pair URL + return the resolved
//      `WalletValue`.
//
// The substrate handles:
//
//   - Scope finalizers (port release, server close) — declared by the
//     substrate primitives we call into.
//   - Endpoint registry publication (we surface the URL/pairUrl via
//     our resolved tag value; the substrate's endpoint-registry
//     primitive consumes the `RoutableDecl` from `routable.ts`).
//   - Manifest emit — the substrate projects from registry. We never
//     write `.devstack/manifest.json` directly.

import { Effect } from 'effect';
import type { FileSystem, Scope } from 'effect';

import type { AccountResourceId, AccountValue } from '../account/index.ts';
import type { DevWalletConnection } from './codegen.ts';
import { walletBootError, type WalletBootError } from './errors.ts';
import { describeAllowedOrigins, resolveOriginPolicy } from './origin-policy.ts';
import { acquirePairingToken, composePairUrl, tokenPath, type PairingToken } from './pairing.ts';
import { startHttpServer, type WalletServerConfig, type WalletServerHandle } from './server.ts';
import { WalletHttpPath } from './protocol.ts';

// ----------------------------------------------------------------------
// User-facing options
// ----------------------------------------------------------------------

import type { ResourceRef } from '../../api/define-plugin.ts';

/** Literal sentinel for `WalletOptions.accounts: 'all'` — every account
 *  member in the stack. Expanded by the composer at `defineDevstack`
 *  call time (api-surface-design §4 D6). Kept as an exported constant
 *  so the wallet factory + composer share one source of truth. */
export const WALLET_ACCOUNTS_ALL = 'all' as const;
export type WalletAccountsAll = typeof WALLET_ACCOUNTS_ALL;

/** A user-supplied account ref. The user passes the result of
 *  `account('alice')` — NOT a bare string. Generic over the literal
 *  account name so the wallet's dependency tuple preserves each
 *  per-account resource id (`account/alice`, `account/bob`, ...). */
export type WalletAccountMember<Name extends string = string> = ResourceRef<
	AccountResourceId<Name>,
	AccountValue
>;

export interface WalletOptions<
	Accounts extends ReadonlyArray<WalletAccountMember> = ReadonlyArray<WalletAccountMember>,
> {
	/** Accounts the wallet binds. Each is yielded for ordering AND its
	 *  resolved value is keyed by address into the sign-handler map.
	 *
	 *  Two shapes:
	 *
	 *   - Explicit tuple — each entry is the plugin/resource ref returned
	 *     by `account('name')`. Pins the bound set at the wallet's call
	 *     site; preserves each literal `account/${Name}` so stack
	 *     composition can validate and recursively expand the refs.
	 *
	 *   - The literal `'all'` — shorthand for "every account member in
	 *     the stack". The composer expands this against the final
	 *     member tuple at `defineDevstack(...)` time (api-surface-design
	 *     §4 D6). The wallet member returned by the factory carries an
	 *     expander hook keyed off `WALLET_ACCOUNTS_ALL` that the
	 *     composer invokes once the account-providing members are
	 *     known. */
	readonly accounts: Accounts | typeof WALLET_ACCOUNTS_ALL;
	/** Extra origins merged on top of the router-fronted dev-server
	 *  origin. Useful for headless test runners and custom dev hosts. */
	readonly allowedOrigins?: ReadonlyArray<string>;
	/** Preferred host port. Substrate's port broker forward-scans if
	 *  this is taken. Default: substrate-picked (no preference). */
	readonly port?: number;
	/** NIC the HTTP server binds. Defaults to `'0.0.0.0'` because the
	 *  router runs in Docker and must reach the host process through the
	 *  host-gateway address on native Linux. The public wallet URL remains
	 *  router-fronted and stack-scoped. */
	readonly bindAddress?: string;
}

// ----------------------------------------------------------------------
// Resolved value (what the wallet plugin publishes)
// ----------------------------------------------------------------------

export interface WalletValue {
	readonly url: string; // router-fronted URL when available, loopback otherwise
	readonly pairUrl: string;
	readonly connection: DevWalletConnection;
	readonly localPort: number;
	readonly token: PairingToken;
	/** Server handle — substrate's scope finalizer chain invokes
	 *  `.close()`; callers don't reach in. Exposed here so tests can
	 *  drive teardown explicitly. */
	readonly server: WalletServerHandle;
}

const WALLET_DEFAULT_BIND_ADDRESS = '0.0.0.0' as const;
const WALLET_DIRECT_URL_HOST = '127.0.0.1' as const;
type WalletPortProbeHost = '127.0.0.1' | '0.0.0.0';

const portProbeHostForBindAddress = (bindAddress: string): WalletPortProbeHost =>
	bindAddress === WALLET_DEFAULT_BIND_ADDRESS ? '0.0.0.0' : '127.0.0.1';

const directUrlHostForBindAddress = (bindAddress: string): string =>
	bindAddress === WALLET_DEFAULT_BIND_ADDRESS ? WALLET_DIRECT_URL_HOST : bindAddress;

// ----------------------------------------------------------------------
// Per-acquire context — supplied by the barrel
// ----------------------------------------------------------------------

/** Inputs from the substrate. The barrel fills these from the
 *  BuildContext; tests can construct directly. */
export interface WalletAcquireContext {
	readonly app: string;
	readonly stack: string;
	readonly network: string;
	/** State root where `wallet/token` lives. Convention:
	 *  `<appDir>/.devstack/stacks/<stack>/runtime`. */
	readonly stateRoot: string;
	/** Port broker seam — returns the allocated port + a scope-
	 *  finalizer-installed release. The barrel adapts the substrate's
	 *  `PortBrokerService.allocate` to this signature so tests can pin
	 *  the port without yielding from a substrate Layer. */
	readonly allocatePort: (
		preferred?: number,
		probeHost?: WalletPortProbeHost,
	) => Effect.Effect<number, WalletBootError, Scope.Scope>;
	/** Account value resolver — the barrel hands this in keyed off the
	 *  BuildContext so the service body stays substrate-agnostic. */
	readonly resolveAccounts: () => Effect.Effect<ReadonlyArray<AccountValue>, WalletBootError>;
	/** Stable router-fronted base URL for this wallet on the stack-scoped
	 *  hostname (e.g. `http://wallet.<app>.localhost:<router-port>`). Null
	 *  only in tests that bypass the router derivation. */
	readonly routerFrontedUrl: string | null;
	/** Stable router-fronted dev-server origin for this stack. Added to
	 *  the wallet allowlist so app+wallet stacks work without repeating
	 *  router origins in user configs. */
	readonly routedAppOrigin: string | null;
}

// ----------------------------------------------------------------------
// Acquire
// ----------------------------------------------------------------------

/**
 * Acquire the wallet service.
 *
 * Distilled-doc invariants honored:
 *
 *   - C12 (mandatory Origin + bearer): both gates are wired in
 *     `server.ts:dispatch`.
 *   - Token comparison constant-time: `pairing.ts:safeBearerEquals`.
 *   - Token file 0o600: `pairing.ts:acquirePairingToken`.
 *   - Token in URL fragment only: `pairing.ts:composePairUrl`.
 *   - Token NEVER in log lines: handlers log only `bearerValid:
 *     boolean`.
 *   - Default bindAddress `'0.0.0.0'`: required for the Docker router to
 *     reach host-loopback services on native Linux.
 *   - Stack-scoped origin allowlist (no cross-stack pairing risk):
 *     `origin-policy.ts:resolveOriginPolicy`.
 */
export const acquireWallet = (
	opts: WalletOptions,
	ctx: WalletAcquireContext,
): Effect.Effect<WalletValue, WalletBootError, Scope.Scope | FileSystem.FileSystem> =>
	Effect.gen(function* () {
		// 1. Resolve the dependency account values. The barrel sets up
		//    `resolveAccounts` to walk the BuildContext via resolved dependencies in
		//    `opts.accounts`; we just project to the address-keyed map.
		const accounts = yield* ctx.resolveAccounts();
		if (accounts.length === 0) {
			return yield* Effect.fail(
				walletBootError({
					phase: 'no-accounts',
					message:
						"wallet resolved zero accounts; add account('name') to the stack or pass accounts explicitly.",
					hint: "`wallet()` and `wallet({ accounts: 'all' })` require at least one account member in the final stack.",
				}),
			);
		}
		const accountsByAddress = new Map<string, AccountValue>();
		for (const acct of accounts) {
			// Two accounts resolving to the same address would silently
			// last-write-wins the sign-route map, so a sign request for
			// that address binds to a non-deterministic account. Fail at
			// boot with the colliding address named.
			if (accountsByAddress.has(acct.address)) {
				return yield* Effect.fail(
					walletBootError({
						phase: 'bind-account',
						message: `wallet resolved two accounts at the same address ${acct.address}; each account must own a distinct address.`,
						hint: 'Remove the duplicate account member, or give the colliding accounts distinct keypairs.',
					}),
				);
			}
			accountsByAddress.set(acct.address, acct);
		}

		// 2. Port allocation. Probe the same host family the real
		//    listener uses, otherwise a process bound on a non-loopback
		//    interface could race the wallet's all-interface listen.
		const bindAddress = opts.bindAddress ?? WALLET_DEFAULT_BIND_ADDRESS;
		const port = yield* ctx.allocatePort(opts.port, portProbeHostForBindAddress(bindAddress));

		// 3. Token mint or rehydrate. Lives at the stack-scoped state root
		//    so warm-start + snapshot-restore preserve the existing
		//    pairing.
		const token = yield* acquirePairingToken(tokenPath(ctx.stateRoot));

		// 4. Origin policy. Allowlist is the router-fronted dev-server
		//    origin for this stack plus any explicit `allowedOrigins`.
		const policy = yield* resolveOriginPolicy({
			app: ctx.app,
			stack: ctx.stack,
			routedAppOrigin: ctx.routedAppOrigin,
			extraOrigins: opts.allowedOrigins ?? [],
		});

		// 5. Start the HTTP server. The dispatcher in `server.ts` owns
		//    route matching + the constant-time bearer compare + the
		//    JSON envelope contract.
		const serverConfig: WalletServerConfig = {
			bindAddress,
			port,
			token,
			policy,
			accountsByAddress,
		};
		const server = yield* startHttpServer(serverConfig);

		// 6. Compose URLs. Router-fronted form when available, loopback
		//    fallback otherwise. The token rides ONLY the fragment — never
		//    a query param — per C13.
		const walletUrl =
			ctx.routerFrontedUrl ?? `http://${directUrlHostForBindAddress(bindAddress)}:${port}`;
		const pairUrl = composePairUrl(walletUrl, token);

		// NON-secret connection metadata only — the token never rides this
		// (it stays in the `0o600` side-channel file the Vite plugin reads by
		// path; `pairUrl`/`token` remain on the resolved value for tests and the
		// snapshot subtree, but are NOT routed through `deployment.json`).
		const connection: DevWalletConnection = {
			walletUrl,
			network: ctx.network,
			allowedOrigins: describeAllowedOrigins(policy),
			protocolPaths: {
				health: WalletHttpPath.HEALTH,
				accounts: WalletHttpPath.ACCOUNTS,
				signTransaction: WalletHttpPath.SIGN_TRANSACTION,
				signPersonalMessage: WalletHttpPath.SIGN_PERSONAL_MESSAGE,
			},
		};

		// Defensive: NEVER log `pairUrl` directly. It carries the token.
		yield* Effect.logInfo('wallet ready').pipe(
			Effect.annotateLogs({
				'wallet.url': walletUrl,
				'wallet.token': 'redacted-fragment',
			}),
		);

		return {
			url: walletUrl,
			pairUrl,
			connection,
			localPort: port,
			token,
			server,
		} satisfies WalletValue;
	});
