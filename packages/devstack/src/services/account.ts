// Account(name, opts?) — single-named account factory.
//
// Returns a typed LayeredTag usable directly as a signer in `Package` /
// `Action` / `Wallet`. The LayeredTag is simultaneously an Effect Layer
// (composed into the stack by `devstack(...)`) and an Effect tag
// (`yield* alice` returns the resolved `Account`).
//
// A spec's `kind:` discriminator selects how the keypair is acquired:
//
//   - 'ephemeral-funded' (default) — generate a fresh Ed25519 keypair,
//     persist it under `.devstack/stacks/<stack>/.keys/<name>.key` so
//     warm starts reuse the same address, and request faucet funding.
//     The faucet endpoint is read off the `Sui` tag's `faucet.host`;
//     pointing at a network with no faucet (mainnet, suiCustom without
//     a faucet) is a configuration error and fails at acquire-time.
//   - 'keystore' — read a `suiprivkey1...` entry from the standard Sui
//     CLI keystore (`~/.sui/sui_config/sui.keystore` by default). The
//     `alias` selects which entry: prefer the alias name from the
//     sibling `sui.aliases` file when present, else fall back to
//     matching by Sui address.
//   - 'env' — read a `suiprivkey1...` from `process.env[key]`. Intended
//     for CI / prod where the secret comes from the environment.
//   - 'inline' — accept a literal `suiprivkey1...` string. Useful for
//     tests where the test author wants a known address.
//   - 'signer' — accept any `@mysten/sui/cryptography` `Signer` instance.
//     Use for HSMs, remote signers, browser-connected wallets under test,
//     or anywhere the secret material lives outside this process.
//     devstack never calls `getSecretKey()` on this branch.
//
// The bare `{}` form is treated as `{kind: 'ephemeral-funded'}` so
// callers without a discriminator keep working without code edits.
//
// Only `ephemeral-funded` writes to disk and only `ephemeral-funded`
// funds; the other four assume the caller has already funded the
// account out-of-band or doesn't need a balance.

import * as nodeFs from 'node:fs/promises';
import * as nodeOs from 'node:os';
import * as nodePath from 'node:path';
import { Effect, FileSystem, Schedule, Schema } from 'effect';
import {
	decodeSuiPrivateKey,
	encodeSuiPrivateKey,
	type SignatureScheme,
} from '@mysten/sui/cryptography';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { Secp256k1Keypair } from '@mysten/sui/keypairs/secp256k1';
import { Secp256r1Keypair } from '@mysten/sui/keypairs/secp256r1';
import type { Keypair, Signer } from '@mysten/sui/cryptography';
import type { SuiClientTypes } from '@mysten/sui/client';
import { Transaction } from '@mysten/sui/transactions';
import { tag, setPhase, type LayeredTag } from '../advanced/tag.js';
import { SuiTag, type Sui } from './sui.js';
import { AccountError } from '../engine/errors.js';
import { publishAccount } from '../engine/registries.js';
import { Leasing } from '../engine/leasing.js';
import { requestFunds } from '../engine/faucet.js';
import { FaucetTag } from './faucet/index.js';
import { StateStoreConfig } from '../engine/state-store.js';
import { servicePath } from '../engine/service-paths.js';
import { stringifyCause } from '../engine/stringify-cause.js';
import type {
	Account as AccountValue,
	BalanceChange,
	SignAndExecuteError,
	SuiObjectChange,
	TxResult,
} from '../engine/shared.js';

// -----------------------------------------------------------------------------
// Contract
// -----------------------------------------------------------------------------

/** Per-account-instance shape. Every per-name account LayeredTag produced by
 *  `Account(name, opts?)` yields a value satisfying this contract.
 *
 *  Re-exported from `engine/shared.ts` so internal services (which import
 *  from `engine/shared.js`) and user code (which imports from this module)
 *  agree on the type. The two used to be separately authored and drifted:
 *  scheme casing, signing return shape, and signing error tags all
 *  diverged before this consolidation.
 *
 *  Lifecycle notes:
 *  - `scheme` is lowercased to match @mysten/sui's
 *    `decodeSuiPrivateKey(...).schema.toLowerCase()` and the on-chain Move
 *    type conventions.
 *  - `signAndExecute` returns the engine's `TxResult` projection (digest +
 *    effects + objectChanges + balanceChanges) AFTER waitForTransaction,
 *    so a follow-up tx referencing a created object never races the
 *    indexer.
 *  - `signTransaction` takes pre-built tx bytes (the dapp-kit adapter
 *    base64-encodes them; the wallet server decodes once and forwards
 *    the Uint8Array) and returns the @mysten/sui Signer's native
 *    `{ bytes, signature }` shape.
 *  - `signPersonalMessage` returns the same `{ signature, bytes }` shape
 *    because dapp-kit personal-message flows need both halves.
 *  - **Signing failures surface as `SignAndExecuteError`, NOT `AccountError`.**
 *    `AccountError` is the *acquisition* error reported when yielding the
 *    per-name account tag (faucet failed, keystore unreadable, etc.).
 */
export type Account = AccountValue;

/** Runtime-validation mirror of `Account`. Use
 *  `Schema.decode(AccountSchema)` to validate a hand-rolled
 *  per-name account tag value, or in tests where you want to assert the
 *  shape on yield. Signing functions are closures (not Schema-validatable)
 *  so they're typed as `Unknown` here. */
export const AccountSchema = Schema.Struct({
	name: Schema.String,
	address: Schema.String,
	scheme: Schema.Literals(['ed25519', 'secp256k1', 'secp256r1']),
	publicKey: Schema.Unknown,
	signAndExecute: Schema.Unknown,
	signTransaction: Schema.Unknown,
	signPersonalMessage: Schema.Unknown,
});

// -----------------------------------------------------------------------------
// Spec
// -----------------------------------------------------------------------------

/**
 * Per-account source discriminator. Selects how the keypair backing
 * the per-name account tag is acquired. See module header for the
 * full lifecycle of each source.
 *
 * Naming note: `kind:` is the DISCRIMINATOR (always a string literal
 * naming the branch — `'env'`, `'keystore'`, `'signer'`, …). The
 * per-branch payload field carries the actual material:
 *   - `kind: 'env'` pairs with `key: string` (env-var name)
 *   - `kind: 'keystore'` pairs with `alias: string` (alias / address)
 *   - `kind: 'inline'` pairs with `privateKey: string` (bech32 literal)
 *   - `kind: 'signer'` pairs with `signer: Signer` (live signer object)
 * So `kind: 'signer'` and the `signer:` payload field are intentionally
 * different shapes: one is the tag selecting the variant, the other is
 * the carrier for the actual `@mysten/sui` `Signer` instance.
 */
export type AccountSource =
	| {
			readonly kind: 'ephemeral-funded';
			/** Wall-clock budget for the faucet funding request, including
			 *  all retries. Defaults to 90_000 (90s) — sized for a cold
			 *  sui-localnet boot. CI configs pointed at a clearly-broken
			 *  faucet can lower this so failure surfaces in seconds
			 *  instead of minutes-per-account.
			 *
			 *  Bounds the faucet funding POST (with retries) — distinct
			 *  from the various `readyTimeoutMs` options on service
			 *  factories (`Sui*Options.readyTimeoutMs`, etc.), which
			 *  bound the socket-level "is the HTTP server bound" probe.
			 *  This one assumes the faucet HTTP server is already
			 *  listening and bounds the actual funding request. */
			readonly faucetTimeoutMs?: number;
			/** Maximum number of faucet retry attempts before giving up
			 *  (the initial attempt plus `faucetMaxAttempts` retries).
			 *  Defaults to 40 — paired with the default 90s budget, the
			 *  schedule saturates well before the wall-clock timeout
			 *  fires. */
			readonly faucetMaxAttempts?: number;
	  }
	| {
			readonly kind: 'keystore';
			/** Alias name (from `sui.aliases`) or the on-chain address. The
			 *  factory tries the alias file first, then falls back to a
			 *  by-address match. */
			readonly alias: string;
			/** Override the default `~/.sui/sui_config/sui.keystore` path. */
			readonly path?: string;
	  }
	| {
			/**
			 * Load a `suiprivkey1...` string from `process.env[key]`.
			 *
			 * The env-var name is taken verbatim; the dev controls it. Prefer narrow
			 * names (`ALICE_PRIVATE_KEY`, not `APP_SECRET`) so the variable's purpose
			 * is unambiguous. The value never appears in logs, spans, or error
			 * messages — only the variable's name is referenced.
			 */
			readonly kind: 'env';
			/** `process.env` variable holding a `suiprivkey1...` bech32 string. */
			readonly key: string;
			/** Reserved for a future raw-hex form. Today the value is always
			 *  bech32 so the scheme is read off the encoded prefix and this
			 *  field is unused. */
			readonly scheme?: 'ed25519' | 'secp256k1' | 'secp256r1';
	  }
	| {
			/**
			 * Use a literal `suiprivkey1...` string embedded in the config.
			 *
			 * **SECURITY: tests and demos only.** The key is serialized as part of
			 * your devstack config — if that file is committed to git, the key is now
			 * in your history. For production code, use `'env'` (load from an env var)
			 * or `'keystore'` (load from `~/.sui/sui_config/sui.keystore`).
			 */
			readonly kind: 'inline';
			/** Bech32 `suiprivkey1...` literal. */
			readonly privateKey: string;
	  }
	| {
			/**
			 * Accept any `@mysten/sui/cryptography` `Signer` instance — a
			 * `Keypair`, a hardware-wallet signer, a remote signer, or
			 * anything else implementing the abstract `Signer` interface.
			 *
			 * Use this when the secret material lives outside devstack's
			 * process entirely (HSM, remote signing service,
			 * browser-connected wallet under test). devstack never asks for
			 * `getSecretKey()` on this branch — the supplied signer's
			 * `signTransaction` / `signPersonalMessage` /
			 * `signAndExecuteTransaction` methods are called directly.
			 */
			readonly kind: 'signer';
			/** Any concrete implementation of `@mysten/sui/cryptography`'s
			 *  `Signer` abstract class. */
			readonly signer: Signer;
			/** Override the derived address. When omitted, `signer.toSuiAddress()`
			 *  is called. Useful for signers whose address is more expensive to
			 *  derive than to memoise. */
			readonly address?: string;
	  }
	| {
			/**
			 * Fork-mode impersonation: execute txs AS `sender` without
			 * possessing its private key. Devstack does NOT call any
			 * signing function for this branch — the per-account
			 * `signTransaction` / `signPersonalMessage` closures throw
			 * synchronously, and `signAndExecute` routes through
			 * `executeImpersonated` (empty-signature gRPC submit).
			 *
			 * Only valid when `sui.runtime === 'forked'` AND `sender`
			 * appears in `sui.fork.seed.addresses` (or you can prove the
			 * fork has it in its owned-object index via `--object`
			 * seeds). The auto-promotion in `Account()` builds this
			 * branch implicitly when the user passes a bare `Account('alice')`
			 * against a fork-mode stack with seed addresses configured —
			 * see Phase 2 of `notes/sui-fork-integration.md`.
			 */
			readonly kind: 'impersonate';
			/** The address to execute as. Must appear in the fork's
			 *  seed manifest's owned-object index (typically by being
			 *  listed in `Sui({fork:{seed:{addresses}}})`). */
			readonly sender: string;
	  };

/**
 * Optional cross-cutting funding spec. After the keypair is resolved
 * (whichever `kind:` branch ran), the Account body iterates these
 * entries and dispatches each to the ambient `Faucet` service's
 * `requestCoin(coinType, address, amount)`. Strategies registered
 * against the Faucet (built-in: SUI HTTP; user-registered: WAL swap,
 * TreasuryCap mint, …) handle the underlying funding mechanism.
 *
 * Independent of `'ephemeral-funded'`'s implicit SUI top-up — funding
 * adds to whatever the source branch did. Useful for:
 *   - Adding non-SUI coins to any account (`WAL` for walrus uploads,
 *     a project-specific stablecoin, …);
 *   - Topping up a `kind: 'env'` / `'keystore'` account at boot.
 *
 * Keys are coin discriminators — short names for built-ins (`'SUI'`,
 * `'WAL'`) or fully-qualified Move types for user coins.
 */
export type AccountFunding = Record<string, bigint>;

/**
 * Per-account spec accepted by `Account(name, opts?)`. Discriminated by
 * `kind:` (see {@link AccountSource}). The bare `{}` form is accepted
 * and treated as `{kind: 'ephemeral-funded'}`. The optional cross-cutting
 * `funding` field works on any branch and dispatches through the
 * ambient `Faucet` service.
 */
export type AccountSpec =
	| (AccountSource & { readonly funding?: AccountFunding })
	| { readonly funding?: AccountFunding };

// -----------------------------------------------------------------------------
// Factory
// -----------------------------------------------------------------------------

/** Factory for a single named account. The returned LayeredTag is both an
 *  Effect Layer (composed into the merged stack by `devstack(...)`) and
 *  an Effect tag (`yield* alice` returns the resolved `Account`).
 *
 *  Default source: `'ephemeral-funded'` — generate a fresh keypair,
 *  persist it under `.devstack/stacks/<stack>/.keys/<name>.key`, and
 *  request faucet funding. Pass `{ kind: 'env', key: '...' }` or
 *  `{ kind: 'keystore', alias: '...' }` for non-localnet stacks. */
// Allowed shape for `Account(name)`: lowercase alphanumeric + dot /
// underscore / hyphen, must start with a letter or digit, max 64 chars.
// The string flows into:
//   - the per-LayeredTag tag id (`account/${name}`), which has to be unique
//     across the stack;
//   - the on-disk path `.devstack/stacks/<stack>/.keys/<name>.key`;
//   - the manifest-side `accounts.<name>.address` lookup key;
//   - docker labels like `devstack.account=<name>` for stack pruning.
// Allowing `..`, `/`, spaces, or other shell-meaningful characters
// would let a typo silently traverse a directory or break docker's
// label parser. Validate at the factory boundary so the failure is
// loud and points at the user's config rather than surfacing as an
// inscrutable filesystem or docker error later.
const ACCOUNT_NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const validateAccountName = (name: string): void => {
	if (!ACCOUNT_NAME_RE.test(name)) {
		throw new TypeError(
			`Account: name '${name}' is invalid — must match ${ACCOUNT_NAME_RE.source} ` +
				`(lowercase alphanumeric + ._- ; must start with a letter or digit; max 64 chars)`,
		);
	}
};

export const Account = <const N extends string>(
	name: N,
	opts?: AccountSpec,
): LayeredTag<`account/${N}`, AccountValue> => {
	validateAccountName(name);
	// Ergonomic shorthand: the bare `{}` form (without a `kind:` key)
	// means "ephemeral-funded with defaults". Branch here so the rest of
	// the body can treat `source` as a fully-discriminated `AccountSource`.
	// Auto-promotion to fork-aware funding happens INSIDE the body when
	// the `kind`-omitted case meets fork mode (we need the `Sui` tag to
	// be resolved before we can know the runtime).
	const initialSource: AccountSource =
		opts !== undefined && 'kind' in opts ? (opts as AccountSource) : { kind: 'ephemeral-funded' };
	const kindOmitted = opts === undefined || !('kind' in opts);
	// Cross-cutting funding spec. Independent of the `kind:` branch —
	// dispatched through `Faucet.requestCoin` after the keypair resolves.
	const funding: AccountFunding =
		opts !== undefined && 'funding' in opts && opts.funding !== undefined ? opts.funding : {};

	const accountTag = tag(
		`account/${name}` as const,
		Effect.fn(`account(${name})`)(function* () {
			const sui = yield* SuiTag;
			const leasing = yield* Leasing;

			// Auto-promotion for bare `Account('alice')` against a
			// fork-mode stack: stay with a real ephemeral keypair (so
			// signTransaction works for downstream tx submission) BUT
			// switch funding from "POST faucet" to "impersonate a seed
			// sender to transfer SUI". The `source` discriminator stays
			// `ephemeral-funded` — the funding branch below decides
			// which path to use based on `sui.runtime`.
			const source: AccountSource = initialSource;
			yield* Effect.annotateCurrentSpan({
				'account.name': name,
				'account.source': source.kind,
				'sui.runtime': sui.runtime,
			});

			if (source.kind === 'keystore' || source.kind === 'env' || source.kind === 'inline') {
				yield* setPhase('loading keystore');
			} else if (source.kind === 'signer') {
				yield* setPhase('binding signer');
			} else if (source.kind === 'impersonate') {
				yield* setPhase('binding impersonation slot');
				// Refuse impersonation outside fork mode — the empty-
				// signature path only works against `sui-fork`.
				if (sui.runtime !== 'forked') {
					return yield* Effect.fail(
						new AccountError({
							phase: 'fund',
							message:
								`Account: '${name}' uses {kind: 'impersonate'} but sui.runtime is ` +
								`'${sui.runtime}'. Impersonation only works on fork-mode networks ` +
								`(Sui({network: 'mainnet-fork' | 'testnet-fork' | 'devnet-fork'})).`,
						}),
					);
				}
			}
			const signer = yield* acquireSigner(name, source);
			const address =
				source.kind === 'signer' && source.address !== undefined
					? source.address
					: source.kind === 'impersonate'
						? source.sender
						: signer.toSuiAddress();
			// HIGH-SEC3: lowercase the scheme at the boundary. The
			// contract claims `'ed25519' | 'secp256k1' | 'secp256r1'`
			// but `signer.getKeyScheme()` returns the mixed-case Sui SDK
			// shape (`'ED25519'`, `'Secp256k1'`, …). The bare cast pre-fix
			// just silenced TS without converting; downstream consumers
			// (manifest serialization, on-chain Move type matching, the
			// dev-wallet adapter) read the field expecting lowercase and
			// quietly diverged.
			const rawScheme = signer.getKeyScheme();
			const scheme = rawScheme.toLowerCase() as AccountValue['scheme'];

			yield* Effect.annotateCurrentSpan({ 'account.address': address });

			if (source.kind === 'ephemeral-funded') {
				// Fork-mode auto-promotion. When `sui.runtime === 'forked'`,
				// the chain has no faucet — but `sui.fork.impersonate` lets
				// us send SUI from a seeded sender. Refuse if the user
				// hasn't configured any seed addresses (we don't have a
				// default seed address; the user's stack must specify one
				// via `Sui({fork:{seed:{addresses}}})`).
				if (sui.runtime === 'forked' && sui.fork !== undefined) {
					if (!kindOmitted) {
						// User explicitly asked for ephemeral-funded on a
						// fork. The HTTP faucet path doesn't exist on fork
						// mode; promote them to the impersonate-funded
						// path with a hint in the error if their seed
						// addresses are empty.
					}
					yield* setPhase('fork-impersonate funding');
					yield* fundEphemeralOnFork({
						name,
						sui,
						newAddress: address,
					});
				} else {
					if (sui.faucet === undefined) {
						return yield* Effect.fail(
							new AccountError({
								phase: 'fund',
								message:
									`Account: '${name}' is ephemeral-funded but the configured Sui has no ` +
									`faucet. Use {kind: 'keystore'|'env'|'inline'} for accounts on this ` +
									`network, or pick the default localnet which exposes a faucet.`,
							}),
						);
					}
				// Host-side faucet — runs in the supervisor process, not inside a container.
				const faucetUrl = sui.faucet.host;
				// Before the first faucet POST, ask the Sui primitive to
				// confirm the chain is actually funds-transferable. The
				// supervisor's Sui-ready gate is socket-level only — the
				// faucet HTTP server is bound but the underlying validator
				// may still be mid-genesis, in which case `/v2/gas` returns
				// 200 OK with body `{status: {Failure: ...}}`. The retry
				// budget in `requestFunds` already absorbs this race for a
				// single account, but each parallel account would otherwise
				// spend its own retry budget rediscovering the same fact;
				// centralizing the wait at `sui` (the primitive memoizes via
				// `Effect.cached`) lets every ephemeral-funded account
				// share one cached resolution.
				yield* setPhase('awaiting chain funds-transferable');
				yield* sui.waitForTransactionsReady().pipe(
					Effect.catchTag('SuiError', (cause) =>
						Effect.fail(
							new AccountError({
								phase: 'fund',
								message: `Account: '${name}' aborted before funding — chain never became funds-transferable: ${cause.message}`,
								cause,
							}),
						),
					),
				);
				yield* setPhase('requesting funds');
				yield* requestFunds({
					faucetUrl,
					address,
					// Surface retry progress so a slow cold-start (sui-faucet
					// binary still warming up, returning 503 or body-level
					// `Failure` for the first ~30s after genesis) doesn't
					// look like a hang in the TUI. `setPhase` mutates the
					// row's status text — the dashboard re-renders within
					// one tick.
					onAttempt: (attempt, err) =>
						setPhase(
							`requesting funds (attempt ${attempt}, last: ${err.message.replace(/\n.*$/s, '')})`,
						),
					// Pass through the per-account retry-budget overrides
					// when present. `requestFunds` falls back to its own
					// defaults (90s / 40 attempts) when these are undefined,
					// so the unset path matches today's behavior exactly.
					...(source.faucetTimeoutMs !== undefined ? { timeoutMs: source.faucetTimeoutMs } : {}),
					...(source.faucetMaxAttempts !== undefined
						? { maxAttempts: source.faucetMaxAttempts }
						: {}),
				}).pipe(
					Effect.catchTag('FaucetError', (cause) =>
						Effect.fail(
							new AccountError({
								phase: 'fund',
								message: `Account: failed to fund '${name}' via ${faucetUrl}`,
								cause,
							}),
						),
					),
				);
				} // end faucet-funded path (sui.runtime !== 'forked')
			}

			// Cross-cutting funding pass. Dispatches each declared coin
			// through the ambient `Faucet` service's strategy registry. If
			// no Faucet is in scope (rare — only unit tests that build the
			// Account layer without devstack(...)), the funding pass is
			// silently a noop. Non-empty `funding` with no Faucet is treated
			// as a noop rather than a failure to keep test ergonomics from
			// regressing.
			if (Object.keys(funding).length > 0) {
				const faucetOpt = yield* Effect.serviceOption(FaucetTag);
				if (faucetOpt._tag === 'Some') {
					const faucet = faucetOpt.value;
					for (const [coinType, amount] of Object.entries(funding)) {
						yield* setPhase(`funding ${coinType}`);
						yield* faucet.requestCoin(coinType, address, amount).pipe(
							Effect.catchTag('FaucetRequestError', (cause) =>
								Effect.fail(
									new AccountError({
										phase: 'fund',
										message: `Account: '${name}' funding of ${amount}n ${coinType} failed: ${cause.message}`,
										cause,
									}),
								),
							),
						);
					}
				}
			}

			yield* publishAccount({ name, address });

			// Serialize tx submission per-address. Two parallel sign+execute
			// calls from the same signer race the gas-coin object's version
			// and one fails with LockedSharedObject. `withExclusive` holds
			// the permit for the lifetime of the work effect and releases
			// it automatically on success, failure, or interrupt.
			//
			// Phase -1 (gRPC migration): the underlying wire call is the
			// gRPC `transactionExecutionService.executeTransaction` via
			// `client.core.executeTransaction`. We mirror the dev-wallet
			// pattern: build the tx to BCS bytes, sign once, submit. The
			// SDK's `SuiGrpcClient.signAndExecuteTransaction` does exactly
			// this internally (see core.ts::signAndExecuteTransaction); we
			// inline it here so the retry/wait/typed-error pipeline stays
			// in one place. `objectChanges` / legacy effects fields are
			// folded back into the devstack-internal `TxResult` shape by
			// `mapGrpcTxResult` so callers downstream of `Account()` see
			// no surface change.
			// Branch for impersonation accounts — no signer needed, the
			// fork executes the tx AS `address` via empty-signature
			// submit. The downstream API surface (return type, retry
			// behavior, wait-for-tx) matches the signed path so callers
			// of `account.signAndExecute(tx)` don't branch on
			// `account.source`.
			const signAndExecuteImpersonate = (
				transaction: Parameters<AccountValue['signAndExecute']>[0],
			) =>
				leasing.withExclusive(
					address,
					Effect.gen(function* () {
						if (sui.fork === undefined) {
							return yield* Effect.fail({
								_tag: 'SignAndExecuteError' as const,
								message:
									`Account: '${name}' is in impersonate mode but sui.fork is undefined ` +
									`(supervisor wiring bug — sui.runtime should be 'forked').`,
							} satisfies SignAndExecuteError);
						}
						const result = yield* sui.fork
							.impersonate(address, transaction as unknown as Parameters<NonNullable<typeof sui.fork>['impersonate']>[1])
							.pipe(
								Effect.mapError(
									(cause): SignAndExecuteError => ({
										_tag: 'SignAndExecuteError',
										message: `Account: impersonate failed for '${name}': ${cause.message}`,
										cause,
									}),
								),
							);
						// Wait for the indexer to see the digest before
						// returning, matching the signed path's behavior.
						yield* Effect.tryPromise({
							try: () => sui.client.waitForTransaction({ digest: result.digest }),
							catch: (cause): SignAndExecuteError => ({
								_tag: 'SignAndExecuteError',
								message: `Account: waitForTransaction failed for '${name}': ${stringifyCause(cause)}`,
								cause,
							}),
						});
						// Return a minimal TxResult — the gRPC response
						// path doesn't carry rich object-change info on the
						// fork's executor today. Callers that need it
						// re-query via `client.core.getTransaction({digest})`.
						return {
							digest: result.digest,
							effects: undefined as unknown as TxResult['effects'],
							objectChanges: [] as ReadonlyArray<SuiObjectChange>,
							balanceChanges: undefined as unknown as ReadonlyArray<BalanceChange>,
						} satisfies TxResult;
					}),
				);

			const signAndExecuteSigned = (transaction: Parameters<AccountValue['signAndExecute']>[0]) =>
				leasing.withExclusive(
					address,
					Effect.tryPromise({
						try: () =>
							sui.client.signAndExecuteTransaction({
								signer,
								transaction,
								include: {
									effects: true,
									balanceChanges: true,
									objectTypes: true,
								},
							}),
						catch: (cause): SignAndExecuteError => ({
							_tag: 'SignAndExecuteError',
							message: `Account: signAndExecute failed for '${name}': ${stringifyCause(cause)}`,
							cause,
						}),
					}).pipe(
						// `signAndExecuteTransaction` resolves gas via the gRPC
						// transaction plugin (`core.executeTransaction` →
						// `resolveTransactionData` in core-resolver.ts). When a
						// freshly-published package is read against a node whose
						// state diverges from the fullnode's tx-execution index,
						// gRPC surfaces the same "Dependent package not found
						// on-chain" message JSON-RPC did. Bounded retry on that
						// specific message preserves the historical behavior —
						// anything else (unfunded account, invalid args, etc.)
						// fails fast.
						Effect.retry({
							times: 6,
							schedule: Schedule.spaced('300 millis'),
							while: (err) => /Dependent package not found on-chain/i.test(err.message),
						}),
						Effect.flatMap((r): Effect.Effect<TxResult, SignAndExecuteError> => {
							const inner = r.Transaction ?? r.FailedTransaction;
							if (inner === undefined) {
								return Effect.fail({
									_tag: 'SignAndExecuteError' as const,
									message: `Account: '${name}' tx returned neither Transaction nor FailedTransaction`,
								});
							}
							if (!inner.status.success) {
								return Effect.fail({
									_tag: 'SignAndExecuteError' as const,
									message:
										inner.status.error?.message ??
										`Account: unknown tx failure for '${name}'`,
								});
							}
							// Block until the RPC's indexer has the tx's
							// effects visible. Without this, a follow-up tx
							// that references an object created here (e.g.
							// a `publish` → `tx.moveCall(${packageId}::…)`
							// sequence) can race the indexer and fail with
							// "Dependent package not found on-chain" even
							// though the publish reported success.
							return Effect.tryPromise({
								try: () => sui.client.waitForTransaction({ digest: inner.digest }),
								catch: (cause): SignAndExecuteError => ({
									_tag: 'SignAndExecuteError',
									message: `Account: waitForTransaction failed for '${name}': ${stringifyCause(cause)}`,
									cause,
								}),
							}).pipe(Effect.as(mapGrpcTxResult(inner)));
						}),
					),
				);

			// Dispatch to the impersonation path when the account is in
			// impersonate mode; otherwise the standard signed path. The
			// public closure is `signAndExecute` either way so callers
			// don't need to branch on `account.source`.
			const signAndExecute =
				source.kind === 'impersonate' ? signAndExecuteImpersonate : signAndExecuteSigned;

			const signTransaction = (transactionBytes: Uint8Array) =>
				Effect.tryPromise({
					try: () => signer.signTransaction(transactionBytes),
					catch: (cause): SignAndExecuteError => ({
						_tag: 'SignAndExecuteError',
						message: `Account: signTransaction failed for '${name}': ${stringifyCause(cause)}`,
						cause,
					}),
				});

			const signPersonalMessage = (messageBytes: Uint8Array) =>
				Effect.tryPromise({
					try: () => signer.signPersonalMessage(messageBytes),
					catch: (cause): SignAndExecuteError => ({
						_tag: 'SignAndExecuteError',
						message: `Account: signPersonalMessage failed for '${name}': ${stringifyCause(cause)}`,
						cause,
					}),
				});

			return {
				name,
				address,
				publicKey: signer.getPublicKey().toRawBytes(),
				scheme,
				// Phase 4 P4.18 — surface the source discriminator so the
				// wallet server's `handleAccounts` can render an
				// "(impersonation)" label on the accounts panel without
				// re-routing through the account spec. `'impersonate'`
				// means we hold NO keys; everything else is a real
				// signer (keystore / env / inline / signer / ephemeral).
				source: source.kind === 'impersonate' ? 'impersonate' : 'real',
				signAndExecute,
				signTransaction,
				signPersonalMessage,
			} satisfies AccountValue;
		})(),
		{
			kind: 'account',
			plugin: 'account',
			displayTitle: `accounts.${name}`,
			// Full address in `primary` — users routinely copy-paste it
			// into faucet UIs, explorers, and tx scripts. The dashboard
			// wraps overflow rather than truncate.
			display: (s) => ({ title: `accounts.${s.name}`, primary: s.address }),
		},
	);
	// Stamp `__kind` so the engine-level kind aligns with the TUI section
	// discriminator. The cast widens the inferred `{name: N}` shape to the
	// broader `Account` contract and erases the per-source R requirements
	// off `__layer`; callers provide those via `devstack(...)` / their test
	// base layer.
	return Object.assign(accountTag, {
		__kind: 'account' as const,
		__pluginName: 'account',
	}) as unknown as LayeredTag<`account/${N}`, AccountValue>;
};

// -----------------------------------------------------------------------------
// Source-specific keypair acquisition. Each branch yields a ready-to-sign
// `Keypair`; downstream code (funding, registry publish, sign closures)
// doesn't care which branch ran.
// -----------------------------------------------------------------------------

type AcquireRequirements = FileSystem.FileSystem | StateStoreConfig;

const acquireSigner = (
	name: string,
	source: AccountSource,
): Effect.Effect<Signer, AccountError, AcquireRequirements> => {
	switch (source.kind) {
		case 'ephemeral-funded':
			return acquireEphemeral(name);
		case 'keystore':
			return acquireFromKeystore(name, source);
		case 'env':
			return acquireFromEnv(name, source);
		case 'inline':
			return decodeKeypair(name, source.privateKey);
		case 'signer':
			return Effect.succeed(source.signer);
		case 'impersonate':
			// No real keypair — return a no-op signer whose `toSuiAddress()`
			// returns the declared sender. The per-account closure layer
			// (`signTransaction` / `signPersonalMessage`) throws when called;
			// only `signAndExecute` succeeds, routed through the
			// impersonation path in the Account body.
			return Effect.succeed(makeImpersonateSigner(source.sender));
	}
};

/**
 * Synthetic `Signer` for fork-mode impersonation accounts. Carries the
 * declared sender as its address but refuses to sign — devstack never
 * needs the secret key on the impersonate branch (the fork executes
 * empty-signature txs natively). `signTransaction` /
 * `signPersonalMessage` throw to surface accidental usage from a
 * caller that bypassed the per-account `signAndExecute` wrapping.
 */
const makeImpersonateSigner = (sender: string): Signer => {
	const synthetic: Partial<Signer> & { toSuiAddress: () => string } = {
		toSuiAddress: () => sender,
		getKeyScheme: () => 'ED25519' as SignatureScheme,
		// `getPublicKey` returns a synthetic-looking PublicKey-shaped
		// object — the SDK accesses `toRawBytes()` to populate
		// `publicKey` on the AccountValue; we feed a 32-byte zero
		// buffer because there's no real public key to surface.
		getPublicKey: () =>
			({
				toRawBytes: () => new Uint8Array(32),
				toSuiAddress: () => sender,
				toBase64: () => '',
			}) as unknown as ReturnType<Signer['getPublicKey']>,
		// Refuse signing — surface a clear error if any caller
		// reaches here without the impersonation routing.
		signTransaction: () => {
			throw new Error(
				`Account: signer for '${sender}' is an impersonation placeholder. ` +
					`signTransaction is not callable on the impersonate branch — devstack ` +
					`routes through executeImpersonated (empty-signature gRPC submit). ` +
					`If you see this, a caller bypassed Account.signAndExecute.`,
			);
		},
		signPersonalMessage: () => {
			throw new Error(
				`Account: signer for '${sender}' is an impersonation placeholder. ` +
					`signPersonalMessage is meaningless on the impersonate branch (the fork's ` +
					`impersonation works at the tx level only).`,
			);
		},
		signWithIntent: () => {
			throw new Error(
				`Account: signer for '${sender}' is an impersonation placeholder. signWithIntent ` +
					`is not callable.`,
			);
		},
	};
	return synthetic as Signer;
};

// -----------------------------------------------------------------------------
// Fork-mode ephemeral funding
// -----------------------------------------------------------------------------
//
// `sui-fork` has no faucet (R1 — the underlying simulacrum executor
// doesn't expose a SUI dispenser at HTTP). Instead, we use
// `sui.fork.impersonate(seedAddress, paySuiTx)` to transfer SUI from a
// seed address to the newly-generated ephemeral keypair. The seed
// addresses come from `Sui({fork:{seed:{addresses}}})` — devstack
// passes them to `sui-fork start --address ...` at container boot,
// which populates the fork's owned-object index so subsequent
// `pay_sui` calls have gas coins to draw from.

/** Default initial funding amount (in MIST) for a fork-mode ephemeral
 *  account. 1 SUI is enough for any realistic dev-mode tx; the fork's
 *  gas pool is fictional anyway. */
const FORK_EPHEMERAL_FUNDING_AMOUNT = 1_000_000_000n; // 1 SUI

const fundEphemeralOnFork = (input: {
	readonly name: string;
	readonly sui: Sui;
	readonly newAddress: string;
}): Effect.Effect<void, AccountError> =>
	Effect.gen(function* () {
		const { sui, newAddress, name } = input;
		const fork = sui.fork;
		if (fork === undefined) {
			return yield* Effect.fail(
				new AccountError({
					phase: 'fund',
					account: name,
					message:
						`Account: '${name}': fork-mode funding requires sui.fork to be defined ` +
						`(supervisor wiring bug — sui.runtime should be 'forked').`,
				}),
			);
		}
		const seedAddresses = fork.seedAddresses;
		if (seedAddresses.length === 0) {
			return yield* Effect.fail(
				new AccountError({
					phase: 'fund',
					account: name,
					message:
						`Account: '${name}' on fork mode requires at least one seed address. ` +
						`Configure via Sui({fork: {seed: {addresses: ['0x...']}}}) so devstack can ` +
						`impersonate a funded sender to transfer SUI to the new ephemeral account. ` +
						`See Phase 2 of notes/sui-fork-integration.md (OD1) for the canonical pattern.`,
				}),
			);
		}
		// Pick the first seed address as the funding source. Multiple
		// seeds are useful for impersonation diversity but funding only
		// needs one (the impersonated `pay_sui` draws from whatever
		// owned objects the seed has — which sui-fork pre-fetched at
		// boot via `--address` on the entrypoint).
		const seed = seedAddresses[0]!;
		// Build a pay_sui tx: split off `FORK_EPHEMERAL_FUNDING_AMOUNT`
		// from the gas coin and transfer to `newAddress`. The fork's
		// executor uses the impersonated sender's owned objects as the
		// gas coin selection pool (the seed manifest pre-populated this
		// at boot time via `--address` on the entrypoint script).
		const tx = new Transaction();
		const [coin] = tx.splitCoins(tx.gas, [tx.pure.u64(FORK_EPHEMERAL_FUNDING_AMOUNT)]);
		tx.transferObjects([coin!], tx.pure.address(newAddress));

		yield* fork.impersonate(seed, tx).pipe(
			Effect.catchTag('SuiError', (cause) =>
				Effect.fail(
					new AccountError({
						phase: 'fund',
						account: name,
						message:
							`Account: '${name}' fork-mode funding via impersonation of ${seed} failed: ` +
							cause.message,
						cause,
					}),
				),
			),
		);
	});

// Persist the bech32 secret key under `runtime/accounts/<name>.key`
// (mode 0o600, dir 0o700) so warm starts keep a stable address. The
// canonical `runtime/` dir (Phase 3 of the snapshot redesign) means
// `snapshot save` tars these keys verbatim and restore puts them back
// at the same path on the target machine.
const acquireEphemeral = (
	name: string,
): Effect.Effect<Keypair, AccountError, AcquireRequirements> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const keysDir = yield* servicePath('accounts');
		const keyPath = `${keysDir}/${name}.key`;

		const exists = yield* fs.exists(keyPath).pipe(Effect.orElseSucceed(() => false));
		if (exists) {
			const raw = yield* fs.readFileString(keyPath).pipe(
				Effect.mapError(
					(cause) =>
						new AccountError({
							phase: 'load-key',
							message: `Account: failed to read key file for '${name}' at ${keyPath}`,
							cause,
						}),
				),
			);
			// Re-tighten perms on warm-start in case an older run wrote
			// the file under a permissive umask. Best-effort — Windows /
			// some filesystems silently no-op.
			yield* bestEffortChmod(fs, keyPath, 0o600);
			return yield* decodeKeypair(name, raw.trim());
		}

		yield* fs.makeDirectory(keysDir, { recursive: true }).pipe(Effect.ignore);
		yield* bestEffortChmod(fs, keysDir, 0o700);

		const keypair = Ed25519Keypair.generate();
		const serialized = encodeSuiPrivateKey(
			decodeSuiPrivateKey(keypair.getSecretKey()).secretKey,
			'ED25519',
		);
		// O_EXCL write so two concurrent first-time `acquireEphemeral(name)`
		// calls (e.g. parallel test fixtures, or two stacks of the same app
		// booted in a tight loop) can't both win — without this each one
		// generates its OWN keypair and the second `writeFileString` clobbers
		// the first, leaving the loser with a Keypair whose secret isn't on
		// disk. With `flag: 'wx'` the loser sees `EEXIST`, falls into the
		// re-read path, and uses the winner's persisted key.
		const writeResult = yield* Effect.tryPromise({
			try: async () => {
				try {
					await nodeFs.writeFile(keyPath, serialized, { flag: 'wx', mode: 0o600 });
					return { kind: 'wrote' as const };
				} catch (err) {
					if ((err as { code?: string }).code === 'EEXIST') {
						return { kind: 'exists' as const };
					}
					throw err;
				}
			},
			catch: (cause) =>
				new AccountError({
					phase: 'write-key',
					message: `Account: failed to write key file for '${name}' at ${keyPath}`,
					cause,
				}),
		});

		if (writeResult.kind === 'exists') {
			// Concurrent winner already wrote a key; read theirs and discard
			// the keypair we just generated.
			const raw = yield* fs.readFileString(keyPath).pipe(
				Effect.mapError(
					(cause) =>
						new AccountError({
							phase: 'load-key',
							message: `Account: lost write race for '${name}' at ${keyPath} but failed to read winner's key`,
							cause,
						}),
				),
			);
			yield* bestEffortChmod(fs, keyPath, 0o600);
			return yield* decodeKeypair(name, raw.trim());
		}

		yield* bestEffortChmod(fs, keyPath, 0o600);
		return keypair;
	});

// Read a `suiprivkey1...` from the standard Sui CLI keystore. The keystore
// is a JSON array of bech32 strings; the sibling `sui.aliases` file maps
// human-friendly names to base64-encoded public keys (flag-prefixed). We
// try alias-name resolution first, then fall back to address matching so
// callers can supply either form transparently.
const acquireFromKeystore = (
	name: string,
	source: Extract<AccountSource, { kind: 'keystore' }>,
): Effect.Effect<Keypair, AccountError> =>
	Effect.gen(function* () {
		const keystorePath = source.path ?? defaultKeystorePath();
		const raw = yield* Effect.tryPromise({
			try: () => nodeFs.readFile(keystorePath, 'utf8'),
			catch: (cause) =>
				new AccountError({
					phase: 'load-key',
					message: `Account: failed to read keystore for '${name}' at ${keystorePath}`,
					cause,
				}),
		});

		const entries = yield* Effect.try({
			try: () => JSON.parse(raw) as Array<string>,
			catch: (cause) =>
				new AccountError({
					phase: 'load-key',
					message: `Account: keystore at ${keystorePath} is not valid JSON`,
					cause,
				}),
		});
		if (!Array.isArray(entries) || entries.length === 0) {
			return yield* Effect.fail(
				new AccountError({
					phase: 'load-key',
					message: `Account: keystore at ${keystorePath} is empty`,
				}),
			);
		}

		// Step 1: try to resolve `alias` via the sibling aliases file. The
		// alias file is a JSON array of `{alias, public_key_base64}` where
		// the base64 payload is `flag || pubkey`. We decode each candidate
		// keypair to compute its derived address, then match either path —
		// by alias name (resolved to a public-key prefix) or by address —
		// before scanning the whole keystore.
		const targetAddress = yield* resolveAliasAddress(keystorePath, source.alias, entries);

		for (const entry of entries) {
			const candidate = yield* decodeKeypair(name, entry).pipe(
				Effect.orElseSucceed(() => undefined as Keypair | undefined),
			);
			if (candidate === undefined) continue;
			const candidateAddress = candidate.getPublicKey().toSuiAddress();
			if (
				candidateAddress === targetAddress ||
				candidateAddress === source.alias ||
				candidateAddress === normalizeAddress(source.alias)
			) {
				return candidate;
			}
		}
		return yield* Effect.fail(
			new AccountError({
				phase: 'load-key',
				message:
					`Account: keystore at ${keystorePath} has no entry matching alias/address ` +
					`'${source.alias}' for '${name}'`,
			}),
		);
	});

const acquireFromEnv = (
	name: string,
	source: Extract<AccountSource, { kind: 'env' }>,
): Effect.Effect<Keypair, AccountError> =>
	Effect.gen(function* () {
		const raw = process.env[source.key];
		if (raw === undefined || raw.length === 0) {
			return yield* Effect.fail(
				new AccountError({
					phase: 'load-key',
					message: `Account: env var '${source.key}' is not set for account '${name}'`,
				}),
			);
		}
		return yield* decodeKeypair(name, raw.trim());
	});

// Bech32-decode a `suiprivkey1...` and dispatch to the matching keypair
// class. The scheme is encoded in the bech32 flag byte, so callers don't
// have to declare it.
const decodeKeypair = (name: string, bech32: string): Effect.Effect<Keypair, AccountError> =>
	Effect.try({
		try: () => {
			const { scheme, secretKey } = decodeSuiPrivateKey(bech32);
			return keypairForScheme(scheme, secretKey);
		},
		catch: (cause) =>
			new AccountError({
				phase: 'decode-key',
				message: `Account: failed to decode private key for '${name}'`,
				cause,
			}),
	});

const keypairForScheme = (scheme: SignatureScheme, secretKey: Uint8Array): Keypair => {
	switch (scheme) {
		case 'ED25519':
			return Ed25519Keypair.fromSecretKey(secretKey);
		case 'Secp256k1':
			return Secp256k1Keypair.fromSecretKey(secretKey);
		case 'Secp256r1':
			return Secp256r1Keypair.fromSecretKey(secretKey);
		default:
			throw new Error(
				`unsupported signature scheme '${scheme}' (MultiSig/ZkLogin/Passkey not yet handled by Account())`,
			);
	}
};

const defaultKeystorePath = (): string =>
	nodePath.join(nodeOs.homedir(), '.sui', 'sui_config', 'sui.keystore');

// Resolve `alias` against the sibling `sui.aliases` file. The file's
// shape is a JSON array of `{alias, public_key_base64}`. When present
// and the alias matches, decode each keystore entry, compare the derived
// public key against the alias entry, and return that entry's address.
// Returns undefined if the alias file doesn't exist or the alias isn't
// found there — keystore matching by address is the fallback path.
const resolveAliasAddress = (
	keystorePath: string,
	alias: string,
	entries: ReadonlyArray<string>,
): Effect.Effect<string | undefined, AccountError> =>
	Effect.gen(function* () {
		const aliasesPath = keystorePath.replace(/\.keystore$/, '.aliases');
		if (aliasesPath === keystorePath) return undefined;

		const raw = yield* Effect.tryPromise({
			try: () => nodeFs.readFile(aliasesPath, 'utf8'),
			catch: () => undefined,
		}).pipe(Effect.orElseSucceed(() => undefined as string | undefined));
		if (raw === undefined) return undefined;

		const parsed = yield* Effect.try({
			try: () =>
				JSON.parse(raw) as Array<{ readonly alias: string; readonly public_key_base64: string }>,
			catch: () => undefined,
		}).pipe(Effect.orElseSucceed(() => undefined as unknown));
		if (!Array.isArray(parsed)) return undefined;

		const match = parsed.find((entry) => entry?.alias === alias);
		if (!match || typeof match.public_key_base64 !== 'string') return undefined;

		for (const entry of entries) {
			const candidate = yield* decodeKeypair('keystore-resolve', entry).pipe(
				Effect.orElseSucceed(() => undefined as Keypair | undefined),
			);
			if (candidate === undefined) continue;
			// The alias file's `public_key_base64` encodes `flag || pubkey`.
			// Compare against the candidate's flagged public key so we don't
			// have to know which scheme each entry uses ahead of time.
			const candidatePublic = candidate.getPublicKey();
			const flagged = new Uint8Array(candidatePublic.toRawBytes().length + 1);
			flagged[0] = candidatePublic.flag();
			flagged.set(candidatePublic.toRawBytes(), 1);
			if (toBase64(flagged) === match.public_key_base64) {
				return candidate.getPublicKey().toSuiAddress();
			}
		}
		return undefined;
	});

const toBase64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64');

// Pad short hex addresses up to the canonical 0x-prefixed 32-byte form
// so callers that supply a truncated address (`0xabc`) still match the
// keystore entry's full form.
const normalizeAddress = (input: string): string => {
	if (!input.startsWith('0x')) return input;
	const hex = input.slice(2);
	if (hex.length >= 64) return `0x${hex.toLowerCase()}`;
	return `0x${hex.padStart(64, '0').toLowerCase()}`;
};

// Best-effort `chmod`. Failures collapse to `Effect.void` because chmod is
// purely defensive (the file already holds the secret).
const bestEffortChmod = (
	fs: FileSystem.FileSystem,
	path: string,
	mode: number,
): Effect.Effect<void> =>
	fs.chmod(path, mode).pipe(
		Effect.catch(() =>
			Effect.tryPromise({
				try: () => nodeFs.chmod(path, mode),
				catch: () => undefined,
			}).pipe(Effect.ignore),
		),
	);

// -----------------------------------------------------------------------------
// gRPC → devstack TxResult adapter (Phase -1)
// -----------------------------------------------------------------------------

// Synthesize the legacy `SuiObjectChange[]` shape from a gRPC
// `Transaction` envelope. Pre-Phase-1, JSON-RPC returned `objectChanges`
// directly; gRPC returns the lower-level `effects.changedObjects[]`
// keyed by `idOperation` + `outputState`, plus a `objectTypes` map of
// objectId → moveType. We fold both into the narrow union devstack
// consumers expect:
//
//   - `idOperation === 'Created'`           → `{type: 'created'}`
//   - `idOperation === 'Deleted'`           → `{type: 'deleted'}`
//   - `outputState === 'PackageWrite'`      → `{type: 'published', packageId: objectId}`
//   - `idOperation === 'None'` && `outputState === 'ObjectWrite'`
//                                            → `{type: 'mutated'}`
//
// The `objectType` lookup falls back to `''` when the type map doesn't
// carry the id (rare — typically only for system-side `0x5`-style
// objects the executor mutates as part of consensus advance). Callers
// that filter on `objectType.endsWith(...)` skip those rows safely.
// Project gRPC's `outputOwner` (`ObjectOwner | null`) down to the
// optional address-owner string the devstack `SuiObjectChange` projection
// carries. Returns `undefined` for shared/object/immutable/unknown owners
// — those map to "no plain address owner" in downstream consumers
// (notably the coin-discovery pass at Phase 0 of
// `notes/coin-auto-discovery.md`).
const addressOwner = (
	outputOwner: SuiClientTypes.ObjectOwner | null | undefined,
): string | undefined => {
	if (outputOwner === null || outputOwner === undefined) return undefined;
	if (outputOwner.$kind === 'AddressOwner') return outputOwner.AddressOwner;
	return undefined;
};

const deriveObjectChanges = (
	changedObjects: ReadonlyArray<SuiClientTypes.ChangedObject>,
	objectTypes: Record<string, string> | undefined,
): ReadonlyArray<SuiObjectChange> => {
	const out: SuiObjectChange[] = [];
	for (const change of changedObjects) {
		if (change.outputState === 'PackageWrite') {
			out.push({ type: 'published', packageId: change.objectId });
			continue;
		}
		const objectType = objectTypes?.[change.objectId] ?? '';
		const owner = addressOwner(change.outputOwner);
		if (change.idOperation === 'Created') {
			out.push({
				type: 'created',
				objectId: change.objectId,
				objectType,
				...(owner !== undefined ? { owner } : {}),
			});
		} else if (change.idOperation === 'Deleted') {
			out.push({ type: 'deleted', objectId: change.objectId, objectType });
		} else if (
			change.idOperation === 'None' &&
			change.outputState === 'ObjectWrite'
		) {
			out.push({
				type: 'mutated',
				objectId: change.objectId,
				objectType,
				...(owner !== undefined ? { owner } : {}),
			});
		}
	}
	return out;
};

const mapBalanceChanges = (
	input: ReadonlyArray<SuiClientTypes.BalanceChange> | undefined,
): ReadonlyArray<BalanceChange> | undefined => {
	if (input === undefined) return undefined;
	return input.map((b) => ({ address: b.address, coinType: b.coinType, amount: b.amount }));
};

const mapGrpcTxResult = (
	inner: SuiClientTypes.Transaction<{
		readonly effects: true;
		readonly balanceChanges: true;
		readonly objectTypes: true;
	}>,
): TxResult => ({
	digest: inner.digest,
	effects: {
		status: {
			status: inner.status.success ? 'success' : 'failure',
			...(inner.status.error?.message !== undefined
				? { error: inner.status.error.message }
				: {}),
		},
	},
	objectChanges: deriveObjectChanges(
		inner.effects?.changedObjects ?? [],
		inner.objectTypes,
	),
	balanceChanges: mapBalanceChanges(inner.balanceChanges),
});
