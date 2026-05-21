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

import type { AccountValue } from '../account/service.ts';
import type { DappKitConfigBindings } from './codegen.ts';
import { walletBootError, type WalletBootError } from './errors.ts';
import { resolveOriginPolicy } from './origin-policy.ts';
import { acquirePairingToken, composePairUrl, tokenPath, type PairingToken } from './pairing.ts';
import { startHttpServer, type WalletServerConfig, type WalletServerHandle } from './server.ts';
import { WalletHttpPath } from './protocol.ts';

// ----------------------------------------------------------------------
// User-facing options
// ----------------------------------------------------------------------

import type { Tag } from '../../substrate/tag.ts';
import type { StackMember } from '../../substrate/plugin.ts';
import type { AccountTagId } from '../account/index.ts';

/** Literal sentinel for `WalletOptions.accounts: 'all'` — every account
 *  member in the stack. Expanded by the composer at `defineDevstack`
 *  call time (api-surface-design §4 D6). Kept as an exported constant
 *  so the wallet factory + composer share one source of truth. */
export const WALLET_ACCOUNTS_ALL = 'all' as const;
export type WalletAccountsAll = typeof WALLET_ACCOUNTS_ALL;

/** A user-supplied account ref. The user passes the result of
 *  `account('alice')` (a `StackMember` providing the per-name account
 *  tag) — NOT a bare tag value. Generic over the literal account name
 *  so the wallet's `consumes: [SuiTag, ...accountTags]` preserves each
 *  per-account tag id (`account/alice`, `account/bob`, ...). Without
 *  that, the stack-composition `MissingProviders` check widens to
 *  `account/${string}` and flags the call site even when the literal
 *  account is present (15-wallet.md "consumes: [SuiTag, ...accountTags]
 *  carries every account tag with its literal id"). */
export type WalletAccountMember<Name extends string = string> = StackMember<
	Tag<AccountTagId<Name>, AccountValue>,
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	ReadonlyArray<Tag<string, any>>,
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	any,
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	any
>;

/** Tuple of per-account tags extracted from a tuple of account
 *  `StackMember`s. Preserves each member's literal name so downstream
 *  `consumes:` tuples and `MissingProviders` keep their narrow ids. */
export type WalletAccountTags<Members extends ReadonlyArray<WalletAccountMember>> = {
	readonly [K in keyof Members]: Members[K]['provides'];
};

export interface WalletOptions<
	Accounts extends ReadonlyArray<WalletAccountMember> = ReadonlyArray<WalletAccountMember>,
> {
	/** Accounts the wallet binds. Each is yielded for ordering AND its
	 *  resolved value is keyed by address into the sign-handler map.
	 *
	 *  Two shapes:
	 *
	 *   - Explicit tuple — each entry is the `StackMember` returned by
	 *     `account('name')`. Pins the bound set at the wallet's call
	 *     site; preserves each literal `account/${Name}` so the
	 *     stack-level `MissingProviders` check fires at compose time.
	 *
	 *   - The literal `'all'` — shorthand for "every account member in
	 *     the stack". The composer expands this against the final
	 *     member tuple at `defineDevstack(...)` time (api-surface-design
	 *     §4 D6). The wallet member returned by the factory carries an
	 *     expander hook keyed off `WALLET_ACCOUNTS_ALL` that the
	 *     composer invokes once the account-providing members are
	 *     known. */
	readonly accounts: Accounts | typeof WALLET_ACCOUNTS_ALL;
	/** Extra origins merged on top of the stack-scoped auto-derived
	 *  origin. Useful for headless test runners and custom dev hosts. */
	readonly allowedOrigins?: ReadonlyArray<string>;
	/** Preferred host port. Substrate's port broker forward-scans if
	 *  this is taken. Default: substrate-picked (no preference). */
	readonly port?: number;
	/** NIC the HTTP server binds. HIGH-SEC1: `'127.0.0.1'` by default.
	 *  Override to `'0.0.0.0'` only for devcontainer / WSL setups. */
	readonly bindAddress?: string;
	/** Opt-in: allowlist the bare `http://localhost:<vite-port>` form.
	 *  Off by default to close the cross-stack pairing risk (see
	 *  `origin-policy.ts` for the long-form rationale). */
	readonly allowLocalhostVite?: boolean;
	/** When true, the plugin emits its `RoutableDecl` so the router
	 *  fronts the wallet under a stack-scoped hostname. Implicitly
	 *  true if any vite plugin is composed on the same stack. */
	readonly enableRouter?: boolean;
}

// ----------------------------------------------------------------------
// Resolved value (what the WalletTag publishes)
// ----------------------------------------------------------------------

export interface WalletValue {
	readonly url: string; // router-fronted URL when available, loopback otherwise
	readonly pairUrl: string;
	readonly bindings: DappKitConfigBindings;
	readonly localPort: number;
	readonly token: PairingToken;
	/** Server handle — substrate's scope finalizer chain invokes
	 *  `.close()`; callers don't reach in. Exposed here so tests can
	 *  drive teardown explicitly. */
	readonly server: WalletServerHandle;
}

// ----------------------------------------------------------------------
// Per-acquire context — supplied by the barrel
// ----------------------------------------------------------------------

/** Inputs from the substrate. The barrel fills these from the
 *  BuildContext; tests can construct directly. */
export interface WalletAcquireContext {
	readonly app: string;
	readonly stack: string;
	readonly chain: string;
	/** State root where `wallet/token` lives. Convention:
	 *  `<appDir>/.devstack/stacks/<stack>/runtime`. */
	readonly stateRoot: string;
	/** Vite port for THIS stack (per-stack scoping — see
	 *  `origin-policy.ts`). `null` if no vite is mounted. */
	readonly vitePortForThisStack: number | null;
	/** Port broker seam — returns the allocated port + a scope-
	 *  finalizer-installed release. The barrel adapts the substrate's
	 *  `PortBrokerService.allocate` to this signature so tests can pin
	 *  the port without yielding from a substrate Layer. */
	readonly allocatePort: (
		preferred?: number,
	) => Effect.Effect<number, WalletBootError, Scope.Scope>;
	/** Account value resolver — the barrel hands this in keyed off the
	 *  BuildContext so the service body stays substrate-agnostic. */
	readonly resolveAccounts: () => Effect.Effect<ReadonlyArray<AccountValue>, WalletBootError>;
	/** Stable router-fronted base URL for this wallet on the stack-scoped
	 *  hostname (e.g. `http://wallet.<app>.localhost:<router-port>`). Null
	 *  when the router isn't running or `enableRouter: false`. */
	readonly routerFrontedUrl: string | null;
	/** Supervisor context captured for log/span propagation on handler
	 *  fibers (the in-process HTTP server forks per-request from this). */
	readonly supervisorCtx: unknown;
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
 *   - Default bindAddress `'127.0.0.1'` (HIGH-SEC1): defaulted here.
 *   - Stack-scoped origin allowlist (no cross-stack pairing risk):
 *     `origin-policy.ts:resolveOriginPolicy`.
 */
export const acquireWallet = (
	opts: WalletOptions,
	ctx: WalletAcquireContext,
): Effect.Effect<WalletValue, WalletBootError, Scope.Scope | FileSystem.FileSystem> =>
	Effect.gen(function* () {
		yield* Effect.annotateCurrentSpan({
			'wallet.app': ctx.app,
			'wallet.stack': ctx.stack,
			'wallet.chain': ctx.chain,
		});

		// 1. Resolve the consumed account tags. The barrel sets up
		//    `resolveAccounts` to walk the BuildContext via each tag in
		//    `opts.accounts`; we just project to the address-keyed map.
		//    Count is annotated AFTER resolution — `opts.accounts` may
		//    be the `'all'` sentinel before composer expansion, so the
		//    resolved-array length is the load-bearing value.
		const accounts = yield* ctx.resolveAccounts();
		yield* Effect.annotateCurrentSpan({
			'wallet.accountCount': accounts.length,
		});
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
			accountsByAddress.set(acct.address, acct);
		}

		// 2. Port allocation.
		const port = yield* ctx.allocatePort(opts.port);

		// 3. Token mint or rehydrate. Lives at the stack-scoped state root
		//    so warm-start + snapshot-restore preserve the existing
		//    pairing.
		const token = yield* acquirePairingToken(tokenPath(ctx.stateRoot));

		// 4. Origin policy. Stack-scoped — only allows THIS stack's vite
		//    port through.
		const policy = yield* resolveOriginPolicy({
			app: ctx.app,
			stack: ctx.stack,
			vitePortForThisStack: ctx.vitePortForThisStack,
			extraOrigins: opts.allowedOrigins ?? [],
			allowLocalhostVite: opts.allowLocalhostVite ?? false,
		});

		// 5. Start the HTTP server. The dispatcher in `server.ts` owns
		//    route matching + the constant-time bearer compare + the
		//    JSON envelope contract.
		const bindAddress = opts.bindAddress ?? '127.0.0.1';
		const serverConfig: WalletServerConfig = {
			bindAddress,
			port,
			token,
			policy,
			accountsByAddress,
			supervisorCtx: ctx.supervisorCtx,
		};
		const server = yield* startHttpServer(serverConfig);

		// 6. Compose URLs. Router-fronted form when available, loopback
		//    fallback otherwise. The token rides ONLY the fragment — never
		//    a query param — per C13.
		const walletUrl = ctx.routerFrontedUrl ?? `http://${bindAddress}:${port}`;
		const pairUrl = composePairUrl(walletUrl, token);

		const bindings: DappKitConfigBindings = {
			walletUrl,
			pairUrl,
			chain: ctx.chain,
			protocolPaths: {
				health: WalletHttpPath.HEALTH,
				accounts: WalletHttpPath.ACCOUNTS,
				signTransaction: WalletHttpPath.SIGN_TRANSACTION,
				signPersonalMessage: WalletHttpPath.SIGN_PERSONAL_MESSAGE,
				execute: WalletHttpPath.EXECUTE,
			},
		};

		yield* Effect.annotateCurrentSpan({
			'wallet.url': walletUrl,
			'wallet.localPort': port,
		});

		// Defensive: NEVER log `pairUrl` directly. The Effect.logInfo
		// here intentionally references the redacted form (the
		// `redactToken` helper is in pairing.ts; we could pipe it here
		// but the simpler safety is "just don't log the full URL").
		yield* Effect.logInfo(`wallet ready at ${walletUrl} (token in fragment, redacted)`);

		return {
			url: walletUrl,
			pairUrl,
			bindings,
			localPort: port,
			token,
			server,
		} satisfies WalletValue;
	});
