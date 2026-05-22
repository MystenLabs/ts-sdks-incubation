// Account plugin — per-stack registry contribution.
//
// Architecture (12-account.md "Outputs / capabilities provided"):
// Account publishes `{name, address}` to a per-stack account
// registry. Downstream consumers (Wallet, Codegen, the manifest
// emitter, Coin's deepbook market maker) look accounts up by name.
//
// The architecture's `strategy-contributor` capability covers this
// shape — Account contributes one entry per acquired account under
// the capability key `account:<name>`. The strategy value is the
// resolved-account view (sans signing closures, which stay scoped
// to the acquire body's lifetime; consumers ask the Account tag
// directly when they need to sign).
//
// Distilled-doc opportunity: today's `publishAccount(...)` writes
// into an engine-singleton registry. The redesign moves it onto the
// capability-decl surface so the substrate orchestrates dedup-by-
// name and last-write-wins without an engine import.

import type { ProjectionDecl } from '../../contracts/projection.ts';
import type { StrategyContributorDecl } from '../../contracts/strategy-contributor.ts';

/** Capability key for the per-name account registry. The literal
 *  form (`account:<name>`) lets downstream consumers (Coin, Wallet,
 *  the manifest emitter) `StrategyFor<Caps, "account:alice">` to
 *  recover the registered address at the type level. */
export type AccountRegistryKey<Name extends string> = `account:${Name}`;

export const accountRegistryKey = <Name extends string>(name: Name): AccountRegistryKey<Name> =>
	`account:${name}` as AccountRegistryKey<Name>;

/** The strategy value published under `account:<name>`. Carries the
 *  load-bearing identity columns only — signing closures stay on
 *  the Account tag's resolved value because their lifetime is
 *  scope-bounded.
 *
 *  Architecture-distilled (12-account.md "Tighten the resolved-
 *  account type"): the `source` discriminator is mandatory so
 *  consumers can branch on impersonation without a `publicKey`
 *  nullcheck (impersonation accounts have a zero-buffer publicKey
 *  — a type-level lie). */
export interface AccountRegistryEntry {
	readonly name: string;
	readonly address: string;
	readonly scheme: 'ed25519' | 'secp256k1' | 'secp256r1';
	readonly source: 'real' | 'impersonate';
	readonly funding: AccountRegistryFunding;
}

export interface AccountRegistryFunding {
	readonly status: 'funded' | 'skipped' | 'unknown';
	readonly balanceMist: string | null;
	readonly requestedMist: string | null;
	readonly entries?: ReadonlyArray<AccountRegistryFundingEntry>;
}

export interface AccountRegistryFundingEntry {
	readonly coin: string;
	readonly fullCoinType: string;
	readonly amount: string;
	readonly status: 'funded' | 'skipped';
}

/** Construct the strategy-contributor decl Account emits for one
 *  acquired identity. Auto-mounted: the registry's role is
 *  infrastructure; the user never types it explicitly. */
export const makeAccountRegistryContribution = <Name extends string>(
	entry: AccountRegistryEntry & { readonly name: Name },
): StrategyContributorDecl<AccountRegistryKey<Name>, AccountRegistryEntry> => ({
	kind: 'strategy-contributor',
	capabilityKey: accountRegistryKey(entry.name),
	strategy: entry,
	autoMounted: true,
});

export const makeAccountProjectionContribution = <Name extends string>(
	entry: AccountRegistryEntry & { readonly name: Name },
): ProjectionDecl => {
	const updatedAt = Date.now();
	return {
		kind: 'projection',
		event: {
			tag: 'account.updated',
			account: {
				key: `account/${entry.name}` as `account/${string}`,
				rowKey: null,
				name: entry.name,
				address: entry.address,
				scheme: entry.scheme,
				source: entry.source,
				funding: entry.funding,
				walletVisible: false,
				updatedAt,
			},
			at: updatedAt,
		},
	};
};
