// Wallet plugin — barrel + `wallet(opts?)` factory.
//
// Architecture (15-wallet.md):
//
//   The wallet bridges devstack (the supervisor host) and the
//   browser-side dev-wallet adapter (in the separate `dev-wallet`
//   package). Two parts:
//
//     1. The IN-PROCESS HTTP server. Owned here. Boot at acquire,
//        serve `/api/v1/devstack/*` routes (health, accounts,
//        sign-transaction, sign-personal-message, execute).
//
//     2. The BROWSER-SIDE ADAPTER. Owned by `dev-wallet`. Reads the
//        codegen-emitted `dapp-kit/config.ts`, constructs a
//        `DevstackSignerAdapter`, registers it with `@mysten/dapp-
//        kit`'s wallet-standard surface.
//
//   The HTTP protocol is the ONE cross-boundary contract. THIS PACKAGE
//   NEVER IMPORTS `@mysten/dapp-kit*` OR `@mysten/wallet-standard`.
//
// Capabilities emitted:
//
//   1. Snapshotable — pairing token under `wallet/token`.
//   2. Codegenable — `dapp-kit-config` bindings (the dev-wallet
//      adapter consumes this). Sensitive flag set — 0o600 + gitignore.
//   3. Routable — wallet UI URL (when `enableRouter: true` OR a vite
//      plugin is composed on the same stack).

import { Effect } from 'effect';

import { capabilities } from '../../api/define-capabilities.ts';
import { consumeMembers } from '../../api/consume-members.ts';
import { defineNodePlugin } from '../../api/define-plugin.ts';
import { defineTag } from '../../api/tag.ts';
import { IdentityContext, StackPathsService } from '../../substrate/runtime/paths.ts';
import { PortBrokerService } from '../../substrate/runtime/port-broker/index.ts';
import { SuiTag } from '../sui/index.ts';
import type { AccountValue } from '../account/service.ts';

import { makeWalletCodegen } from './codegen.ts';
import { WALLET_ERROR_TAGS, walletBootError } from './errors.ts';
import { makeWalletRoutable } from './routable.ts';
import { makeWalletSnapshotable } from './snapshot.ts';
import {
	acquireWallet,
	WALLET_ACCOUNTS_ALL,
	type WalletAcquireContext,
	type WalletAccountMember,
	type WalletAccountTags,
	type WalletOptions,
	type WalletValue,
} from './service.ts';
import type { AnyMember } from '../../substrate/plugin.ts';

/** Wallet `consumes:` shape — Sui (hard upstream for ordering) plus
 *  the per-account-tag tuple projected from the user-supplied account
 *  member tuple. Preserving each literal `account/${Name}` is load-
 *  bearing for the stack-composition `MissingProviders` check. */
type WalletConsumes<Accounts extends ReadonlyArray<WalletAccountMember>> = readonly [
	typeof SuiTag,
	...WalletAccountTags<Accounts>,
];

/** Composer-side expander hook for `wallet({ accounts: 'all' })`. The
 *  wallet factory cannot know the stack's account members at its own
 *  call site (members are introduced positionally to `defineDevstack`
 *  AFTER the wallet factory has returned). The composer detects this
 *  symbol on a member returned by the wallet factory, collects every
 *  account-providing member from the final stack, and invokes the
 *  hook to produce the real wallet member with a populated `consumes`
 *  tuple — keeping the dep-graph edges accurate.
 *
 *  Symbol-keyed (not a named property) so it cannot collide with any
 *  user-facing member field. Globally registered via `Symbol.for(...)`
 *  so the composer can look it up without importing the wallet
 *  module's symbol-binding (this side-steps a TS2742 inferred-type
 *  portability error: a `unique symbol`-keyed property in the wallet
 *  member's return type would leak the symbol's compile-time identity
 *  into the user's `defineDevstack(...)` inferred Stack type, forcing
 *  every example's default export to carry an explicit annotation). */
export const WALLET_EXPAND_ACCOUNTS_ALL: symbol = Symbol.for('devstack.wallet.expand-accounts-all');

/** Runtime-only expander shape attached to the placeholder wallet
 *  member when the user passes `accounts: 'all'`. The composer reads
 *  `member[WALLET_EXPAND_ACCOUNTS_ALL](accountMembers)` to mint the
 *  resolved-tuple wallet member.
 *
 *  Kept as a value-level shape (not a type-level intersection on the
 *  factory's return signature) so the symbol-keyed property does NOT
 *  leak into the user's inferred Stack type (see TS2742 note above). */
export type WalletExpandAccountsAllExpander = (
	accountMembers: ReadonlyArray<WalletAccountMember>,
) => AnyMember;

// ----------------------------------------------------------------------
// Tag — the resolved value consumers read
// ----------------------------------------------------------------------

/** The wallet plugin's identity tag. ONE per stack (15-wallet.md
 *  "singleton per stack"). The id is `'wallet'` (singular). */
export const WalletTag = defineTag<'wallet', WalletValue>('wallet', 'wallet');

// ----------------------------------------------------------------------
// User-facing factory
// ----------------------------------------------------------------------

/**
 * Construct the wallet plugin.
 *
 * Two parts of the wallet:
 *
 *   - HERE: HTTP server + token + pairing protocol + codegen.
 *   - DEV-WALLET PACKAGE: `@mysten/dapp-kit`-shaped adapter the
 *     user-app's frontend bundle imports.
 *
 *  Distilled-doc invariant (15-wallet.md "Always explicit"): the
 *  composer NEVER auto-mounts the wallet. The user MUST call
 *  `wallet({ accounts: [alice, bob] })` and pass the result to
 *  `defineDevstack(...)`.
 *
 *  ### Security defaults
 *
 *   - `bindAddress: '127.0.0.1'` (HIGH-SEC1). Only the loopback is
 *     bound; sibling-machine devices on the LAN cannot reach the
 *     signing endpoints.
 *
 *   - `allowLocalhostVite: false`. The bare `http://localhost:<vite>`
 *     form is OFF by default — opt-in for headless test runners /
 *     custom dev hosts. Defaulting it on would let a sibling stack
 *     running vite on the same port pair with this wallet (because
 *     `localhost` is not stack-scoped). See `origin-policy.ts` for
 *     the rationale.
 *
 *   - Pairing token in URL fragment only (`#token=<32-hex>`). Never
 *     in query params (would land in access logs / referrers).
 *
 *   - Constant-time bearer compare on every request.
 *
 *   - Token file `0o600`. Codegen output (`dapp-kit/config.ts`)
 *     `0o600` + gitignored via `sensitive: true`.
 */
export function wallet<const Accounts extends ReadonlyArray<WalletAccountMember>>(
	opts: Omit<WalletOptions, 'accounts'> & { readonly accounts: Accounts },
): ReturnType<typeof makeWalletMember<Accounts>>;
export function wallet(
	opts: Omit<WalletOptions, 'accounts'> & { readonly accounts: typeof WALLET_ACCOUNTS_ALL },
): ReturnType<typeof makeWalletMember<readonly []>>;
export function wallet(opts: WalletOptions): AnyMember {
	if (opts.accounts === WALLET_ACCOUNTS_ALL) {
		// Deferred placeholder. `consumes` carries only `[SuiTag]` —
		// the composer rewrites the member once it knows which account
		// members are in the stack (api-surface-design §4 D6). Without
		// composer expansion, the wallet would race account funding;
		// WITH composer expansion, every per-account `consumes` edge is
		// in place by the time the dep-graph builds.
		//
		// Type-level: the placeholder's `consumes` is `[SuiTag]`. A
		// wider `ReadonlyArray<account/${string}>` would widen the
		// stack-level `MissingProviders` check to the template literal
		// (which never reduces to any concrete `account/<name>`), so
		// the placeholder MUST stay narrow.
		//
		// Runtime: the symbol-keyed expander is attached as a value-
		// only property; the factory's declared return type
		// intentionally does NOT surface it (a `unique symbol`-keyed
		// member field would leak into the user's inferred Stack type
		// and trigger TS2742 "type cannot be named without a reference
		// to ./node_modules/.../plugins/wallet" at every example's
		// default export).
		const placeholder = makeWalletMember(opts, [] as const);
		const expander: WalletExpandAccountsAllExpander = (accountMembers) =>
			makeWalletMember({ ...opts, accounts: accountMembers }, accountMembers);
		(placeholder as unknown as Record<symbol, unknown>)[WALLET_EXPAND_ACCOUNTS_ALL] = expander;
		return placeholder;
	}
	return makeWalletMember(opts, opts.accounts);
}

function makeWalletMember<Accounts extends ReadonlyArray<WalletAccountMember>>(
	opts: WalletOptions,
	accounts: Accounts,
) {
	// `consumes` MUST include every account tag's key (15-wallet.md
	// "upstreamKeys MUST include SuiTag.key + every account tag" — same
	// load-bearing invariant). The substrate's topological scheduler
	// uses `consumes` to drive build order; without including the
	// account tags here, the wallet would race account funding and the
	// first `signTransaction` would fail with `address-not-found`.
	//
	// `consumeMembers` projects each member's `.provides` tag and
	// pre-builds the `projectInScope` closure used inside `acquire` —
	// the localized §14 cast lives inside the helper.
	const consumedAccounts = consumeMembers(accounts);
	const consumes = [
		SuiTag,
		...consumedAccounts.consumesTags,
	] as unknown as WalletConsumes<Accounts>;

	// The resolved-opts shape acquireWallet sees has accounts pinned to
	// the resolved tuple — `'all'` is purely a user-surface convenience
	// the composer never propagates to the supervisor.
	const resolvedOpts: WalletOptions<Accounts> = { ...opts, accounts };

	return defineNodePlugin({
		provides: WalletTag,
		// Hard upstreams: Sui (for ordering — wallet must boot strictly
		// after Sui is ready) + every account (for ordering AND value).
		consumes,
		// `leaf-long-running` — the HTTP server is a long-lived host
		// process; per-request handlers fork off the supervisor-context
		// fiber but the server itself lives for the stack's lifetime.
		kind: 'leaf-long-running',
		// `rebootCost: 'cheap'` — restart is bounded by the port-broker
		// allocator + an http listen + a token-file read. The on-disk
		// token survives so the dev-wallet pairing isn't disturbed.
		rebootCost: 'cheap',
		acquire: (ctx) =>
			Effect.gen(function* () {
				// Pull identity, the stack-paths bundle, and the port-
				// broker from the supervisor-provided substrate context.
				// `StackPathsService.stackRoot` is the on-disk root for
				// per-stack runtime artifacts (incl. `wallet/token`); the
				// port broker is per-stack (Layer-driven, one instance per
				// stack scope); the wallet's scope hangs off the
				// supervisor's `acquireScope`, so any release finalizer
				// installed by these primitives unwinds with the rest of
				// the plugin's resources on cycle / teardown.
				const identity = yield* IdentityContext;
				const paths = yield* StackPathsService;
				const portBroker = yield* PortBrokerService;

				// Resolve each consumed account upstream via direct member
				// refs. `consumes` above pins `m.provides` for each `m` in
				// the resolved account list, so the runtime BuildContext
				// walker is guaranteed to find the entry. The §14 cast
				// lives inside `consumeMembers` — call site reads the
				// resolved tuple directly.
				const resolvedAccounts: ReadonlyArray<AccountValue> = consumedAccounts.projectInScope(ctx);

				const acquireCtx: WalletAcquireContext = {
					app: identity.app,
					stack: identity.stack,
					chain: identity.chain,
					stateRoot: paths.stackRoot,
					vitePortForThisStack: null,
					allocatePort: (preferred) =>
						portBroker
							.allocate({
								kind: 'wallet',
								preferredPort: preferred,
							})
							.pipe(
								Effect.map((alloc) => alloc.port),
								Effect.mapError((err) =>
									walletBootError({
										phase: 'allocate-port',
										message: `port-broker allocate failed: ${err.detail}`,
										hint:
											err.reason === 'preferred-busy'
												? 'another plugin in this stack is using your preferred port; omit `port` to let the broker pick.'
												: err.reason === 'no-free-port'
													? 'the wallet kind-window is exhausted; check for stray devstack supervisors holding ports.'
													: 'bind-probe failed — likely a privileged port or jail restriction.',
										cause: err,
									}),
								),
							),
					resolveAccounts: () => Effect.succeed(resolvedAccounts),
					routerFrontedUrl: null,
					supervisorCtx: undefined,
				};

				return yield* acquireWallet(resolvedOpts, acquireCtx);
			}),
		errorContributions: [
			{
				_tag: 'PluginErrorContribution',
				errorTags: WALLET_ERROR_TAGS,
			},
		],
		// Dynamic capability factory — receives the resolved
		// `WalletValue` + acquire context. Stamps the real dapp-kit
		// bindings (walletUrl, pairUrl, chain id, paths) into the
		// codegen decl, and the real identity app/stack into the
		// routable decl.
		capabilities: (resolved, acquireCtx) => {
			const snapshot = makeWalletSnapshotable();
			const codegen = makeWalletCodegen(resolved.bindings);
			const routable = makeWalletRoutable({
				app: acquireCtx.identity.app,
				stack: acquireCtx.identity.stack,
				port: resolved.localPort,
			});
			return opts.enableRouter === true
				? capabilities(snapshot, codegen, routable)
				: capabilities(snapshot, codegen);
		},
	});
}

// ----------------------------------------------------------------------
// Re-exports
// ----------------------------------------------------------------------

export type {
	WalletOptions,
	WalletValue,
	WalletAccountMember,
	WalletAccountTags,
	WalletAccountsAll,
} from './service.ts';
export { WALLET_ACCOUNTS_ALL } from './service.ts';
export type { DappKitConfigBindings } from './codegen.ts';
export {
	WalletHttpPath,
	WALLET_PROTOCOL_PREFIX,
	WALLET_AUTH_HEADER,
	WALLET_BEARER_PREFIX,
	WALLET_TOKEN_FRAGMENT_KEY,
	WALLET_TOKEN_HEX_LENGTH,
	SignRequestSchema,
	SignResponseSchema,
	ExecuteRequestSchema,
	ExecuteResponseSchema,
	HealthResponseSchema,
	AccountsResponseSchema,
	AccountSummarySchema,
	ErrorResponseSchema,
	SuiAddressSchema,
	Base64Schema,
	SignatureSchemeSchema,
	AccountSourceSchema,
	type WalletHttpPathValue,
	type SignRequest,
	type SignResponse,
	type ExecuteRequest,
	type ExecuteResponse,
	type HealthResponse,
	type AccountsResponse,
	type AccountSummary,
	type ErrorResponse,
} from './protocol.ts';
export type {
	WalletError,
	WalletBootError,
	WalletBootPhase,
	WalletRequestError,
	WalletRequestPhase,
} from './errors.ts';
export { WALLET_ERROR_TAGS } from './errors.ts';
export type { OriginPolicy, OriginPolicyInputs, OriginCheckResult } from './origin-policy.ts';
export { resolveOriginPolicy, checkOrigin, corsHeadersFor } from './origin-policy.ts';
export type { PairingToken } from './pairing.ts';
export {
	mintToken,
	acquirePairingToken,
	tokenPath,
	composePairUrl,
	parsePairUrl,
	parseBearerHeader,
	safeBearerEquals,
	redactToken,
} from './pairing.ts';
export { WALLET_ENDPOINT_NAME, makeWalletRoutable } from './routable.ts';
export {
	dispatch,
	startHttpServer,
	MAX_BODY_BYTES,
	type WalletRequest,
	type WalletResponse,
	type WalletServerConfig,
	type WalletServerHandle,
} from './server.ts';
export { makeWalletCodegen } from './codegen.ts';
export { makeWalletSnapshotable } from './snapshot.ts';
