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
//      Dispatched through the ambient Faucet's strategy registry.
//      No strategy in scope for a given coin ⇒ silent noop
//      (architecture-mandated test-ergonomics contract, distilled-doc
//      invariant: "Optional Faucet is a noop, not an error").
//
// Distilled-doc invariant: per-address serialization — concurrent
// funding requests for the same address MUST serialize. We share the
// substrate `LeaseBroker` handle from `service.ts` and open a fresh
// scope per wire call so the lease releases the moment that call
// returns. Each cross-cutting iteration is its own scope: the broker
// is non-reentrant by design, so a hypothetical loop holding a single
// lease across iterations would deadlock the second one.

import { Effect } from 'effect';

import type { FaucetStrategy } from '../faucet/strategies/sui-local.ts';
import {
	faucetCapabilityFor,
	StrategyRegistryService,
} from '../../substrate/runtime/strategy-registry/index.ts';
import type { ResourceRef } from '../../api/define-plugin.ts';
import type { LeaseBroker } from '../../substrate/runtime/lease-broker/index.ts';
import type { ChainId } from '../../substrate/brand.ts';
import type { CoinResourceId, CoinValue } from '../coin/index.ts';

import { accountAcquireError, type AccountAcquireError } from './errors.ts';
import { withAddressLease } from './lease.ts';

/** Direct resource ref shape for a coin upstream. The user passes the
 *  result of `coin.local(...)` / `coin.witness(...)` / `coin.known(...)`
 *  / `coin.builtin(...)` — NOT a bare string or discriminator. Generic
 *  over the literal symbol so the account's dependency tuple preserves
 *  each per-coin resource id (`coin:USDC`, `coin:WAL`, ...).
 *
 *  Architecture (Direct Member Refs): cross-plugin references at the
 *  user-facing surface are plugin/resource refs directly — no opaque
 *  tag or string discriminator vocabulary. */
export type CoinMember<Sym extends string = string> = ResourceRef<CoinResourceId<Sym>, CoinValue>;

/** A single cross-cutting funding entry. `coin` is a direct member ref
 *  (the value returned by `coin.local(...)` etc.) — the account plugin
 *  threads it through `dependsOn` so the substrate's dep graph forces
 *  the publishing / discovery edge to land before funding.
 *
 *  Distilled-doc invariant ("Strict upstream declaration"): coin
 *  references cited by Account must force a dep edge. */
export interface CrossCuttingFundingEntry<M extends CoinMember = CoinMember> {
	readonly coin: M;
	readonly amount: bigint;
}

/** Internal projected shape — the acquire body in `account/index.ts`
 *  receives each funding entry's resolved `CoinValue`, reads
 *  `fullCoinType`, and passes the projected entries to
 *  `applyCrossCuttingFunding`. The funding pass never sees the raw
 *  member refs — keeps the strategy dispatch logic
 *  substrate-name-blind. */
export interface ProjectedFundingEntry {
	readonly fullCoinType: string;
	readonly amount: bigint;
}

export type ProjectedFunding = ReadonlyArray<ProjectedFundingEntry>;

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
	readonly suiMode: 'local' | 'external' | 'live' | 'fork';
	/** Resolved sui chain id — the substrate-level chain identity used
	 *  to compose the faucet strategy's capability key
	 *  (`faucet:request:<chainId>`). */
	readonly chainId: ChainId;
	/** Loud-by-default auto-promotion event (called on fork before the
	 *  strategy is invoked, per the architecture's "no silent surprises"
	 *  principle). */
	readonly emitAutoPromotionEvent: () => Effect.Effect<void>;
	/** Substrate lease-broker handle — funding opens a fresh scope per
	 *  wire call and acquires the per-address lease so concurrent wire
	 *  calls for the same address serialize at the chain boundary. */
	readonly broker: LeaseBroker;
}

/** Apply the default-funding pass for an ephemeral account.
 *
 *  Wiring: yields `StrategyRegistryService` (the R-channel from
 *  Round 7), looks up the faucet strategy registered by the Sui
 *  plugin under `faucet:request:<chainId>`, and dispatches a request
 *  through it. Per-address serialization is enforced by acquiring
 *  the address lock around the wire call. */
export const fundEphemeralDefault = (
	parts: FundEphemeralDefaultArgs,
): Effect.Effect<void, AccountAcquireError, StrategyRegistryService> =>
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
			return;
		}

		// Look up the strategy. Sui auto-registers a faucet strategy
		// on non-fork modes; fork-mode strategies have to be supplied
		// by the faucet plugin (with the fork admin closed over). If
		// nothing is registered we surface a typed, actionable error
		// pointing at the architecture's contract: ephemeral-on-non-
		// fork without a Faucet MUST fail at acquire time.
		const strategy = yield* faucetCapabilityFor<FaucetStrategy>(parts.chainId).pipe(
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
								? 'Fork networks have no HTTP faucet — supply a fork-admin-cap-mint strategy via faucet({strategies:[...]}) keyed by this chain id.'
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
				accountAcquireError({
					phase: 'fund-default',
					accountName: parts.accountName,
					variant: 'ephemeral',
					message:
						`Account '${parts.accountName}': faucet strategy request failed ` +
						`for chain '${parts.chainId}' (tag=${cause._tag}).`,
					cause,
					hint:
						'See the cause chain — typical roots are the faucet container ' +
						'not yet ready (FaucetUnreachable), the wall-clock budget elapsed ' +
						'(FaucetExhausted), or the body returned Failure (FaucetBodyError).',
				}),
			);
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

		yield* Effect.annotateCurrentSpan({
			'account.name': parts.accountName,
			'account.address': parts.address,
			'fund.amount.mist': parts.amountMist.toString(),
			'sui.chain': parts.chainId,
			'sui.mode': parts.suiMode,
		});
	}).pipe(
		Effect.withSpan('devstack.plugin.account.fundEphemeralDefault', {
			attributes: {
				'account.name': parts.accountName,
				'account.address': parts.address,
				'sui.mode': parts.suiMode,
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
	readonly funding: ProjectedFunding;
	readonly chainId: ChainId;
	readonly broker: LeaseBroker;
}

/** Apply the cross-cutting funding pass. Variant-agnostic — runs for
 *  every variant once the keypair / impersonation slot is bound and
 *  the address is known.
 *
 *  Distilled-doc invariant: "Optional Faucet is a noop, not an
 *  error". Absence of a registered strategy for a coin's capability
 *  key short-circuits silently (the entry is dropped). This lets a
 *  test author opt INTO cross-cutting funding without the stack
 *  having to know whether the surrounding network can satisfy it.
 *
 *  Wiring: SUI entries (`fullCoinType === '0x2::sui::SUI'`) dispatch
 *  through `faucet:request:<chainId>` (same key as the default pass);
 *  other entries dispatch through `coinType:<fullCoinType>` keys
 *  contributed by the respective Coin/Walrus/Seal plugins.
 *
 *  Entries are processed SERIALLY (one wire call at a time per
 *  address) so the per-address lock and the on-chain sequence number
 *  agree at every step. */
export const applyCrossCuttingFunding = (
	parts: ApplyCrossCuttingFundingArgs,
): Effect.Effect<void, AccountAcquireError, StrategyRegistryService> =>
	Effect.gen(function* () {
		if (parts.funding.length === 0) {
			return;
		}
		const registry = yield* StrategyRegistryService;

		for (const entry of parts.funding) {
			// Resolve the capability key from the projected coin type.
			//
			// SUI (`0x2::sui::SUI`) → reuse the faucet-request key so the
			// SUI auto-registered strategy fields the request (this
			// matches the default-funding pass and keeps the registry
			// surface uniform).
			//
			// Everything else → `coinType:<fullCoinType>` so user-defined
			// Coin plugins (and Walrus's exchange strategy keyed by
			// `coinType:<WAL fullCoinType>`) can contribute strategies
			// declaratively.
			const isSui = entry.fullCoinType === SUI_FULL_COIN_TYPE;
			const coinKey = `coinType:${entry.fullCoinType}` as const;
			const lookup = isSui
				? faucetCapabilityFor<FaucetStrategy>(parts.chainId)
				: registry.get<typeof coinKey, FaucetStrategy>(coinKey);

			// Architecture-distilled: optional-faucet-is-noop. If no
			// strategy is registered for this coin, drop the entry
			// silently. Wire calls only fire when something IS wired.
			const strategy = yield* lookup.pipe(
				Effect.catchTag('StrategyNotFoundError', () =>
					Effect.succeed(null as FaucetStrategy | null),
				),
			);
			if (strategy === null) {
				continue;
			}

			const wrapCrossCuttingFailure = (cause: {
				readonly _tag: 'FaucetUnreachable' | 'FaucetExhausted' | 'FaucetBodyError';
			}) =>
				Effect.fail(
					accountAcquireError({
						phase: 'fund-cross-cutting',
						accountName: parts.accountName,
						variant: 'ephemeral',
						message:
							`Account '${parts.accountName}': cross-cutting funding ` +
							`failed for coin (key='${isSui ? `faucet:request:${parts.chainId}` : coinKey}') amount=${entry.amount} ` +
							`(tag=${cause._tag}).`,
						cause,
						hint:
							'Cross-cutting funding requires the matching strategy ' +
							'to be registered at the time of acquire — check the ' +
							'plugin that contributes this coin (Coin/Walrus/etc.).',
					}),
				);
			yield* withAddressLease(
				parts.broker,
				parts.accountName,
				parts.address,
				strategy.request({ address: parts.address, amount: entry.amount }).pipe(
					Effect.catchTags({
						FaucetUnreachable: wrapCrossCuttingFailure,
						FaucetExhausted: wrapCrossCuttingFailure,
						FaucetBodyError: wrapCrossCuttingFailure,
					}),
				),
			);
		}

		yield* Effect.annotateCurrentSpan({
			'account.name': parts.accountName,
			'account.address': parts.address,
			'fund.cross-cutting.count': parts.funding.length,
			'sui.chain': parts.chainId,
		});
	}).pipe(
		Effect.withSpan('devstack.plugin.account.applyCrossCuttingFunding', {
			attributes: {
				'account.name': parts.accountName,
				'account.address': parts.address,
				'fund.cross-cutting.entries': parts.funding.length,
			},
		}),
	);
