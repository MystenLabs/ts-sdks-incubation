// Cross-plugin account-funding strategy contract.
//
// This is the neutral substrate contract shared by `account` (which
// dispatches strategies via the strategy registry) and contributing
// plugins (`coin`, `walrus`, `deepbook`, future user-authored coin
// publishers) that ship strategies for specific chain/coin keys.
//
// Architecture (ARCHITECTURE.md §"Plugin A ↔ Plugin B coupling"):
//   - Account is the identity-bus; it OWNS the funding dispatcher.
//   - Coin/Walrus/Deepbook are CONTRIBUTORS; they ship per-coin
//     `AccountFundingStrategy` values via `strategyContributor` decls.
//
// Lifting the shared shape here breaks the Account↔Coin/Walrus/Deepbook
// round-trip cross-import. Plugin barrels MAY re-export these types for
// ergonomics (e.g. `plugins/account/index.ts` re-exports them so the
// root barrel's public surface is unchanged) but the substrate IS the
// single source of truth.
//
// The interfaces are generic over the resolved account handle (`A`).
// The substrate stays name-blind per STYLE_GUIDE §7; the `account`
// plugin barrel re-exports each interface fixed to its concrete
// `AccountValue` so consumers see the real handle type. Strategies
// shipped by contributing plugins import the account-barrel form
// (going through the account bus per architecture) and never reach
// for substrate generics directly.
//
// Distilled-doc invariant ("Optional Faucet is a noop, not an error"):
// the dispatcher in `plugins/account/funding.ts` silently drops
// strategy-missing for non-SUI coins. Strategies themselves declare
// their own error channel via the `E` type parameter so the
// dispatcher's wrap step can map domain failures into
// `AccountAcquireError`.

import type { Effect } from 'effect';

/** Request passed to account funding strategies. `amount` uses the
 *  funded coin's smallest unit. The resolved account handle (`account`)
 *  is present so strategies without an admin signer can perform
 *  account-owned swaps while still sharing the central funding
 *  dispatcher. */
export interface AccountFundingRequest<A = unknown> {
	readonly address: string;
	readonly amount: bigint;
	/** Resolved handle for the funded account, when one is available. Present
	 *  for the boot-time funding pass (the funded address IS a stack account) and
	 *  required by account-spending strategies (`requiresRecipientAccount`), which
	 *  swap the recipient's own SUI. Mint-style strategies that transfer to a
	 *  passive recipient ignore it, so it is optional — a caller funding an
	 *  arbitrary `0x…` recipient (e.g. the dashboard) may leave it undefined. */
	readonly account?: A;
}

/** Strategy interface a contributing plugin satisfies to participate in
 *  cross-cutting account funding for a specific coin key. Generic over
 *  the resolved account handle (`A`) and the strategy's own error
 *  channel (`E`). */
export interface AccountFundingStrategy<E = unknown, A = unknown> {
	readonly request: (req: AccountFundingRequest<A>) => Effect.Effect<void, E>;
	/** True when the strategy calls `account.withTransactionSigner`.
	 *  The dispatcher must not acquire the same non-reentrant
	 *  per-address lease outside the strategy. */
	readonly usesAccountSigner?: boolean;
	/** True when the strategy spends the *recipient's own* funds (an
	 *  account-owned swap — WAL/DEEP buy the coin with the recipient's SUI), so
	 *  the recipient MUST be a resolved account with a signer (`req.account`).
	 *  Distinct from `usesAccountSigner`: a mint-style strategy signs with the
	 *  publisher's account (so `usesAccountSigner` is true) yet transfers to a
	 *  *passive* recipient that need not be a stack account, leaving this false.
	 *  Callers (e.g. the dashboard fund action) gate the "recipient must be an
	 *  account" check on this flag, not on `usesAccountSigner`. */
	readonly requiresRecipientAccount?: boolean;
}
