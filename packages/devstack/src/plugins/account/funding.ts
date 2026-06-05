// Account plugin — funding logic.
//
// Two funding paths converge here:
//
//   1. **Default funding** — applies to the `ephemeral` variant only.
//      On non-fork networks: faucet POST via the SUI HTTP strategy
//      auto-registered by Faucet (see 11-faucet.md). On fork networks:
//      "pay from a seed via impersonation" because forks have no
//      faucet. The auto-promotion is LOUD by default per the
//      architecture's "no silent surprises" principle — we emit a
//      `log.appended` event the first time a stack hits this path.
//
//   2. **Cross-cutting funding** — declared per-account via
//      `AccountOptions.funding`. Applies to every variant.
//      Dispatched through the ambient strategy registry. Missing
//      strategy for non-SUI coins ⇒ silent noop (architecture-
//      mandated test-ergonomics contract, distilled-doc invariant:
//      "Optional Faucet is a noop, not an error"). Explicit SUI
//      entries use the SUI faucet strategy and fail loudly when no
//      faucet-bearing strategy exists.
//
// Distilled-doc invariant: per-address serialization — concurrent
// funding requests for the same address MUST serialize. We share the
// substrate `LeaseBroker` handle from `service.ts` and open a fresh
// scope per wire call so the lease releases the moment that call
// returns. Each cross-cutting iteration is its own scope: the broker
// is non-reentrant by design, so a hypothetical loop holding a single
// lease across iterations would deadlock the second one.

import { Effect } from 'effect';

import { FAUCET_CAPABILITY_KEY_PREFIX, type FaucetStrategy } from '../faucet/index.ts';
import {
	chainKeyedStrategyFor,
	StrategyRegistryService,
} from '../../substrate/runtime/strategy-registry/index.ts';
import type { AnyResourceRef, ResourceRef } from '../../api/define-plugin.ts';
import type { LeaseBroker } from '../../substrate/runtime/lease-broker/index.ts';
import type {
	AccountFundingRequest as ContractAccountFundingRequest,
	AccountFundingStrategy as ContractAccountFundingStrategy,
} from '../../contracts/funding-strategy.ts';
import { setCurrentPluginPhase } from '../../substrate/runtime/current-plugin.ts';
import {
	BALANCE_POLL_PROFILE,
	makeBoundedSpacedSchedule,
} from '../../substrate/runtime/retry-policy.ts';

import {
	accountAcquireError,
	type AccountAcquireError,
	type AccountVariantKind,
} from './errors.ts';
import { withAddressLease } from './lease.ts';
import { fundingFailureError } from '../internal/funding-failure-error.ts';
import type { AccountValue } from './service.ts';
import { AccountSpans } from './spans.ts';
import { SuiSpans } from '../sui/index.ts';

// `CoinResourceId` is the literal-typed resource id the coin plugin
// publishes. Inlined here as `coin:${Sym}` so this file does NOT
// cross-import the coin plugin — the substrate's compose-time dedup
// works by string equality on the resource id, and the coin plugin's
// `coinResourceId` constructor produces the same shape. This is the
// per-Task-A "inline the literal type alias" decision (the literal
// pattern is the contract; promoting it to a substrate type would
// be more ceremony than the single string template warrants).
type CoinResourceId<Sym extends string> = `coin:${Sym}`;

/** Direct resource ref shape for a coin upstream. The user passes the
 *  result of `coin.fromPackage(...)` / `coin.known(...)` /
 *  `coin.builtin(...)` — NOT a bare string or discriminator. Generic
 *  over the literal symbol so the account's dependency tuple preserves
 *  each per-coin resource id (`coin:managed_coin/managed_coin`,
 *  `coin:wal`, ...).
 *
 *  Architecture (Direct Member Refs): cross-plugin references at the
 *  user-facing surface are plugin/resource refs directly — no opaque
 *  tag or string discriminator vocabulary. */
export interface AccountFundingCoinValue {
	readonly fullCoinType: string;
	readonly symbol?: string;
}

export type CoinMember<Sym extends string = string> = ResourceRef<
	CoinResourceId<Sym>,
	AccountFundingCoinValue
>;

/** Optional dependency edge for the plugin that contributes the
 *  funding strategy. Coin refs force the coin metadata edge; `via`
 *  forces the strategy-provider edge (e.g. a known DeepBook
 *  deployment that contributes `coinType:<DEEP>`). */
export type CrossCuttingFundingProvider = AnyResourceRef | readonly AnyResourceRef[];

/** Built-in SUI funding entry. This uses the same account funding
 *  list as arbitrary coins but avoids requiring `coin.builtin('sui')`
 *  for the normal SUI faucet path. */
export interface SuiFundingEntry {
	readonly coin: 'sui';
	readonly amount: number | bigint;
}

/** A single cross-cutting funding entry. `coin` is a direct member ref
 *  (the value returned by `coin.fromPackage(...)` etc.) — the account plugin
 *  threads it through `dependsOn` so the substrate's dep graph forces
 *  the publishing / discovery edge to land before funding.
 *
 *  Distilled-doc invariant ("Strict upstream declaration"): coin
 *  references cited by Account must force a dep edge. `via` is the
 *  same contract for the strategy contributor that can satisfy the
 *  funding request. */
export interface CrossCuttingFundingEntry<M extends CoinMember = CoinMember> {
	readonly coin: M;
	readonly amount: bigint;
	readonly via?: CrossCuttingFundingProvider;
}

export type AccountFundingEntry<M extends CoinMember = CoinMember> =
	| SuiFundingEntry
	| CrossCuttingFundingEntry<M>;

export type AccountFunding = ReadonlyArray<AccountFundingEntry>;

/** Internal projected shape — the acquire body in `account/index.ts`
 *  receives each funding entry's resolved `CoinValue`, reads
 *  `fullCoinType`, and passes the projected entries to
 *  `applyCrossCuttingFunding`. The funding pass never sees the raw
 *  member refs — keeps the strategy dispatch logic
 *  substrate-name-blind. */
export interface ProjectedFundingEntry {
	readonly coin: string;
	readonly fullCoinType: string;
	readonly amount: bigint;
}

export type ProjectedFunding = ReadonlyArray<ProjectedFundingEntry>;

/** Outcome marker carried on each `applied` entry — distinguishes a
 *  faucet/strategy call that actually moved funds (`'funded'`) from
 *  the short-circuit case where the existing balance already covered
 *  the request (`'already-satisfied'`). Downstream projection turns
 *  this into the `AccountRegistryFundingEntry.status` column so a
 *  no-faucet-call entry is not mislabeled as "funded".
 *
 *  Distilled-doc invariant: the `applied` projection must reflect
 *  what actually happened — not the user's request shape. */
export type AppliedFundingOutcome = 'funded' | 'already-satisfied';

export interface AppliedFundingEntry extends ProjectedFundingEntry {
	readonly outcome: AppliedFundingOutcome;
}

export type AppliedFunding = ReadonlyArray<AppliedFundingEntry>;

export interface AccountFundingResult {
	readonly requested: ProjectedFunding;
	readonly applied: AppliedFunding;
}

/** Account-bus projection of the substrate funding-request contract
 *  (`contracts/funding-strategy.ts`). Narrows the contract's generic
 *  account-handle slot to the concrete `AccountValue` this plugin
 *  publishes; strategies inside account or in sibling plugins
 *  (coin/walrus/deepbook) see the real handle type without re-stating
 *  the substrate shape. */
export type AccountFundingRequest = ContractAccountFundingRequest<AccountValue>;

/** Account-bus projection of the substrate strategy contract. The
 *  generic account-handle slot is fixed to `AccountValue` so
 *  contributing plugins receive a typed account handle. */
export type AccountFundingStrategy<E = unknown> = ContractAccountFundingStrategy<E, AccountValue>;

export interface FundingBalanceReader {
	readonly readBalance: (args: {
		readonly owner: string;
		readonly coinType: string;
	}) => Effect.Effect<bigint | null>;
}

/** Sentinel brand identifying the test-only no-op reader. Surfaced as
 *  a separate `readonly skipFinalityWait?: true` discriminator on
 *  `NULL_BALANCE_READER` so the funding pass can short-circuit the
 *  finality wait deterministically WITHOUT exhausting the bounded
 *  poll schedule. Production readers MUST NOT set this. */
interface NullBalanceReader extends FundingBalanceReader {
	readonly skipFinalityWait: true;
}

/** Test-only no-op balance reader.
 *
 *  Production callers (`account/service.ts`) build a real reader from
 *  the live SDK via `makeFundingBalanceReader`; the funding pass
 *  REQUIRES a reader so the post-faucet finality wait is load-bearing
 *  on real wire calls. Tests that don't model the read/poll loop pass
 *  this sentinel to explicitly opt OUT of the wait. Requiring an
 *  explicit reader means a production caller that forgets to wire one
 *  fails loudly rather than silently short-circuiting the wait. */
export const NULL_BALANCE_READER: FundingBalanceReader = {
	readBalance: () => Effect.succeed(null),
	skipFinalityWait: true,
} as NullBalanceReader;

const skipsFinalityWait = (reader: FundingBalanceReader): boolean =>
	(reader as NullBalanceReader).skipFinalityWait === true;

/** The canonical builtin SUI coin type. Used by the funding dispatch
 *  to route SUI entries to the faucet strategy (same key as the
 *  default-funding pass), and by everything that needs to detect
 *  "this is the protocol-defined SUI". Mirrors `BUILTIN_COINS.sui`
 *  in the coin plugin. */
export const SUI_FULL_COIN_TYPE = '0x2::sui::SUI' as const;

/** Default funding amount for ephemeral accounts — 1 SUI in MIST.
 *  Documented at the user-facing factory so a bare `account('alice')`
 *  is predictable. */
export const DEFAULT_EPHEMERAL_FUND_MIST = 1_000_000_000n;

/** Inputs the default-funding pass needs from the per-acquire ctx. */
export interface FundEphemeralDefaultArgs {
	readonly accountName: string;
	readonly address: string;
	readonly amountMist: bigint;
	readonly suiMode: 'local' | 'local-rpc' | 'live' | 'fork';
	/** Resolved sui chain id — the substrate-level chain identity used
	 *  to compose the faucet strategy's capability key
	 *  (`faucet:request:<chainId>`). */
	readonly chainId: string;
	/** Loud-by-default auto-promotion event (called on fork before the
	 *  strategy is invoked, per the architecture's "no silent surprises"
	 *  principle). */
	readonly emitAutoPromotionEvent: () => Effect.Effect<void>;
	/** Substrate lease-broker handle — funding opens a fresh scope per
	 *  wire call and acquires the per-address lease so concurrent wire
	 *  calls for the same address serialize at the chain boundary. */
	readonly broker: LeaseBroker;
	/** Required. Production callers build this from the SDK via
	 *  `makeFundingBalanceReader`; tests that don't model the read/poll
	 *  loop opt out explicitly with `NULL_BALANCE_READER`. The previous
	 *  optional shape allowed a silent `Effect.void` short-circuit on
	 *  the finality wait when callers forgot to wire it. */
	readonly balanceReader: FundingBalanceReader;
}

/** Outcome of `fundEphemeralDefault`. `'skipped'` covers the
 *  zero-amount no-op; `'already-satisfied'` covers the pre-existing-
 *  balance short-circuit (no faucet call); `'funded'` covers the
 *  successful wire path. Callers project this into the `applied`
 *  shape so the `funded`-vs-`already-satisfied` distinction survives
 *  to the registry projection. */
export type FundEphemeralDefaultOutcome = 'funded' | 'already-satisfied' | 'skipped';

/** Apply the default-funding pass for an ephemeral account.
 *
 *  Wiring: yields `StrategyRegistryService` (the R-channel from
 *  Round 7), looks up the faucet strategy registered by the Sui
 *  plugin under `faucet:request:<chainId>`, and dispatches a request
 *  through it. Per-address serialization is enforced by acquiring
 *  the address lock around the wire call. */
export const fundEphemeralDefault = (
	parts: FundEphemeralDefaultArgs,
): Effect.Effect<FundEphemeralDefaultOutcome, AccountAcquireError, StrategyRegistryService> =>
	Effect.gen(function* () {
		// LOUD AUTO-PROMOTION — distilled-doc invariant: "no silent
		// surprises". Emit BEFORE attempting the dispatch so the user
		// sees the path change even if the wire call subsequently
		// fails. On fork we surface the path-change event; on non-fork
		// the strategy registered by Sui IS the canonical default and
		// no auto-promotion is needed.
		if (parts.suiMode === 'fork') {
			yield* parts.emitAutoPromotionEvent();
		}

		// Zero-amount short-circuit — both real strategies treat zero
		// as a no-op; doing the same here avoids a registry lookup +
		// span emission for the legitimately-no-funding case.
		if (parts.amountMist <= 0n) {
			return 'skipped' as const;
		}

		yield* setCurrentPluginPhase('checking SUI funding');
		const existingBalance = yield* readExistingBalance(parts.balanceReader, {
			owner: parts.address,
			coinType: SUI_FULL_COIN_TYPE,
		});
		if (existingBalance !== null && existingBalance >= parts.amountMist) {
			return 'already-satisfied' as const;
		}

		// Look up the strategy. Sui auto-registers a faucet strategy
		// on non-fork modes; fork-mode strategies have to be supplied
		// by the faucet plugin (with the fork admin closed over). If
		// nothing is registered we surface a typed, actionable error
		// pointing at the architecture's contract: ephemeral-on-non-
		// fork without a Faucet MUST fail at acquire time.
		const strategy = yield* chainKeyedStrategyFor<FaucetStrategy>(
			FAUCET_CAPABILITY_KEY_PREFIX,
			parts.chainId,
		).pipe(
			Effect.catchTag('StrategyNotFoundError', (err) =>
				Effect.fail(
					accountAcquireError({
						phase: 'fund-default',
						accountName: parts.accountName,
						variant: 'ephemeral',
						message:
							`Account '${parts.accountName}': no faucet strategy registered for ` +
							`chain '${parts.chainId}' (sui mode=${parts.suiMode}). ` +
							`Registered keys: [${err.registeredKeys.join(', ')}].`,
						hint:
							parts.suiMode === 'fork'
								? 'Fork networks have no HTTP faucet — compose a plugin that contributes defineFaucetStrategy(...) for this chain id.'
								: 'Ensure a sui() plugin with a faucet-bearing mode (local/live-testnet/live-devnet) is in the stack.',
					}),
				),
			),
		);

		// Per-address serialization around the wire call. The lease is
		// scope-bound and releases as soon as `request(...)` returns;
		// two concurrent funding requests for the same address — e.g.
		// ephemeral default + cross-cutting SUI top-up — interleave
		// deterministically via the broker's FIFO queue.
		const wrapFaucetFailure = (cause: {
			readonly _tag: 'FaucetUnreachable' | 'FaucetExhausted' | 'FaucetBodyError';
		}) =>
			Effect.fail(
				fundingFailureError({
					phase: 'fund-default',
					accountName: parts.accountName,
					variant: 'ephemeral',
					chainId: parts.chainId,
					cause,
				}),
			);
		yield* setCurrentPluginPhase('funding SUI');
		yield* withAddressLease(
			parts.broker,
			parts.accountName,
			parts.address,
			strategy.request({ address: parts.address, amount: parts.amountMist }).pipe(
				Effect.catchTags({
					FaucetUnreachable: wrapFaucetFailure,
					FaucetExhausted: wrapFaucetFailure,
					FaucetBodyError: wrapFaucetFailure,
				}),
			),
		);
		yield* setCurrentPluginPhase('waiting for SUI funding settlement');
		yield* waitForBalanceAtLeast({
			balanceReader: parts.balanceReader,
			accountName: parts.accountName,
			variant: 'ephemeral',
			phase: 'fund-default',
			owner: parts.address,
			coinType: SUI_FULL_COIN_TYPE,
			coinLabel: 'SUI',
			amount: parts.amountMist,
		});

		yield* Effect.annotateCurrentSpan({
			[AccountSpans.name]: parts.accountName,
			[AccountSpans.address]: parts.address,
			[AccountSpans.fundAmountMist]: parts.amountMist.toString(),
			[SuiSpans.chain]: parts.chainId,
			[SuiSpans.mode]: parts.suiMode,
		});
		return 'funded' as const;
	}).pipe(
		Effect.withSpan('devstack.plugin.account.fundEphemeralDefault', {
			attributes: {
				[AccountSpans.name]: parts.accountName,
				[AccountSpans.address]: parts.address,
				[SuiSpans.mode]: parts.suiMode,
			},
		}),
	);

/** Inputs the cross-cutting funding pass needs from the per-acquire ctx.
 *
 *  `funding` is the PROJECTED shape — the acquire body in
 *  `account/index.ts` receives each user-supplied `CoinMember` as a
 *  resolved dependency and projects to `{fullCoinType, amount}` BEFORE
 *  invoking this pass. Keeps the dispatch logic substrate-name-blind. */
export interface ApplyCrossCuttingFundingArgs {
	readonly accountName: string;
	readonly address: string;
	readonly variant: AccountVariantKind;
	readonly account: AccountValue;
	readonly funding: ProjectedFunding;
	readonly chainId: string;
	readonly broker: LeaseBroker;
	/** Required. See `FundEphemeralDefaultArgs.balanceReader`. */
	readonly balanceReader: FundingBalanceReader;
}

/** Apply the cross-cutting funding pass. Variant-agnostic — runs for
 *  every variant once the keypair / impersonation slot is bound and
 *  the address is known.
 *
 *  Distilled-doc invariant: "Optional Faucet is a noop, not an
 *  error". Absence of a registered strategy for a non-SUI coin's
 *  capability key short-circuits silently (the entry is dropped).
 *  Explicit SUI entries are stricter: they route through the active
 *  chain's faucet strategy and fail loudly when none is registered.
 *  This lets a test author opt INTO arbitrary-coin funding without
 *  forcing every surrounding network to satisfy every custom coin.
 *
 *  Wiring: SUI entries (`fullCoinType === '0x2::sui::SUI'`) dispatch
 *  through `faucet:request:<chainId>` (same key as the default pass);
 *  other entries dispatch through `coinType:<fullCoinType>` keys
 *  contributed by the respective Coin/Walrus/Seal plugins.
 *
 *  Entries are processed serially. Strategies that use the resolved
 *  account signer acquire the per-address lease internally; strategies
 *  that do not are wrapped by this dispatcher. */
export const applyCrossCuttingFunding = (
	parts: ApplyCrossCuttingFundingArgs,
): Effect.Effect<AppliedFunding, AccountAcquireError, StrategyRegistryService> =>
	Effect.gen(function* () {
		if (parts.funding.length === 0) {
			return [];
		}
		const registry = yield* StrategyRegistryService;
		const applied: AppliedFundingEntry[] = [];

		for (const entry of parts.funding) {
			if (entry.amount <= 0n) {
				continue;
			}

			yield* setCurrentPluginPhase(`checking ${entry.coin} funding`);
			const existingBalance = yield* readExistingBalance(parts.balanceReader, {
				owner: parts.address,
				coinType: entry.fullCoinType,
			});
			if (existingBalance !== null && existingBalance >= entry.amount) {
				applied.push({ ...entry, outcome: 'already-satisfied' });
				continue;
			}

			// Resolve the capability key from the projected coin type.
			//
			// SUI (`0x2::sui::SUI`) → reuse the faucet-request key so the
			// SUI auto-registered strategy fields the request (this
			// matches the default-funding pass and keeps the registry
			// surface uniform). The faucet contract takes
			// `{address, amount}` only (it never sees the resolved
			// account handle) — kept as its own helper so the typing is
			// honest at the dispatch site.
			//
			// Everything else → `coinType:<fullCoinType>` so user-defined
			// Coin plugins (and Walrus's exchange strategy keyed by
			// `coinType:<WAL fullCoinType>`) can contribute strategies
			// declaratively. These satisfy `AccountFundingStrategy` and
			// receive the resolved account handle in the request.
			const isSui = entry.fullCoinType === SUI_FULL_COIN_TYPE;
			const coinKey = `coinType:${entry.fullCoinType}` as const;
			const key = isSui ? (`faucet:request:${parts.chainId}` as const) : coinKey;

			const wrapCrossCuttingFailure = (cause: unknown): AccountAcquireError =>
				fundingFailureError({
					phase: 'fund-cross-cutting',
					accountName: parts.accountName,
					variant: parts.variant,
					key,
					amount: entry.amount,
					cause,
				});

			let request: Effect.Effect<void, AccountAcquireError>;
			let usesAccountSigner = false;
			if (isSui) {
				// FaucetStrategy lookup — request shape is `{address, amount}`.
				// Architecture-distilled: explicit SUI entries are the
				// normal gas faucet path, so missing strategy is
				// actionable and loud (no silent drop).
				const strategy = yield* chainKeyedStrategyFor<FaucetStrategy>(
					FAUCET_CAPABILITY_KEY_PREFIX,
					parts.chainId,
				).pipe(
					Effect.catchTag('StrategyNotFoundError', (err) =>
						Effect.fail(
							accountAcquireError({
								phase: 'fund-cross-cutting',
								accountName: parts.accountName,
								variant: parts.variant,
								message:
									`Account '${parts.accountName}': no SUI funding strategy registered ` +
									`for chain '${parts.chainId}'. Registered keys: [${err.registeredKeys.join(', ')}].`,
								cause: err,
								hint: 'Ensure a sui() plugin with a faucet-bearing mode (local/live-testnet/live-devnet) is in the stack.',
							}),
						),
					),
				);
				request = strategy
					.request({ address: parts.address, amount: entry.amount })
					.pipe(Effect.mapError(wrapCrossCuttingFailure));
			} else {
				// AccountFundingStrategy lookup — request shape is
				// `{address, amount, account}`. Architecture-distilled:
				// optional-faucet-is-noop for arbitrary coins — missing
				// registration short-circuits silently rather than
				// failing the acquire.
				const strategy = yield* registry
					.get<typeof coinKey, AccountFundingStrategy>(coinKey)
					.pipe(
						Effect.catchTag('StrategyNotFoundError', () =>
							Effect.succeed(null as AccountFundingStrategy | null),
						),
					);
				if (strategy === null) {
					continue;
				}
				usesAccountSigner = strategy.usesAccountSigner === true;
				request = strategy
					.request({ address: parts.address, amount: entry.amount, account: parts.account })
					.pipe(Effect.mapError(wrapCrossCuttingFailure));
			}

			yield* setCurrentPluginPhase(`funding ${entry.coin}`);
			yield* usesAccountSigner
				? request
				: withAddressLease(parts.broker, parts.accountName, parts.address, request);
			yield* setCurrentPluginPhase(`waiting for ${entry.coin} funding settlement`);
			yield* waitForBalanceAtLeast({
				balanceReader: parts.balanceReader,
				accountName: parts.accountName,
				variant: parts.variant,
				phase: 'fund-cross-cutting',
				owner: parts.address,
				coinType: entry.fullCoinType,
				coinLabel: entry.coin,
				amount: entry.amount,
			});
			applied.push({ ...entry, outcome: 'funded' });
		}

		yield* Effect.annotateCurrentSpan({
			[AccountSpans.name]: parts.accountName,
			[AccountSpans.address]: parts.address,
			[AccountSpans.fundCrossCuttingCount]: parts.funding.length,
			[SuiSpans.chain]: parts.chainId,
		});
		return applied;
	}).pipe(
		Effect.withSpan('devstack.plugin.account.applyCrossCuttingFunding', {
			attributes: {
				[AccountSpans.name]: parts.accountName,
				[AccountSpans.address]: parts.address,
				[AccountSpans.fundCrossCuttingEntries]: parts.funding.length,
			},
		}),
	);

const readExistingBalance = (
	balanceReader: FundingBalanceReader,
	args: {
		readonly owner: string;
		readonly coinType: string;
	},
): Effect.Effect<bigint | null> => balanceReader.readBalance(args);

const waitForBalanceAtLeast = (parts: {
	readonly balanceReader: FundingBalanceReader;
	readonly accountName: string;
	readonly variant: AccountVariantKind;
	readonly phase: 'fund-default' | 'fund-cross-cutting';
	readonly owner: string;
	readonly coinType: string;
	readonly coinLabel: string;
	readonly amount: bigint;
}): Effect.Effect<void, AccountAcquireError> => {
	const reader = parts.balanceReader;
	// Test-only opt-out — the `NULL_BALANCE_READER` sentinel explicitly
	// declares "this caller doesn't model the read/poll loop". Production
	// readers never set `skipFinalityWait`, so the wait stays load-bearing
	// on real wire calls.
	if (skipsFinalityWait(reader)) {
		return Effect.void;
	}
	return Effect.gen(function* () {
		const read = readExistingBalance(reader, {
			owner: parts.owner,
			coinType: parts.coinType,
		});
		const lastBalance = yield* read.pipe(
			Effect.repeat({
				schedule: makeBoundedSpacedSchedule(
					BALANCE_POLL_PROFILE.intervalMs,
					BALANCE_POLL_PROFILE.timeoutMs,
				),
				until: (balance) => balance !== null && balance >= parts.amount,
			}),
		);
		if (lastBalance !== null && lastBalance >= parts.amount) {
			return;
		}
		return yield* Effect.fail(
			accountAcquireError({
				phase: parts.phase,
				accountName: parts.accountName,
				variant: parts.variant,
				message:
					`Account '${parts.accountName}': funding for ${parts.coinLabel} was accepted ` +
					`but balance did not reach ${parts.amount} before the settlement timeout ` +
					`(last=${lastBalance === null ? '<unavailable>' : lastBalance}).`,
				hint:
					'The faucet or funding strategy returned before the funded coin became spendable. ' +
					'Check the funding strategy finality gate and Sui RPC health.',
			}),
		);
	});
};
