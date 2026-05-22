// Account plugin — barrel + `account(name, opts?)` factory.
//
// Architecture (12-account.md): Account is the named-identity layer
// for devstack. It acquires a keypair (or impersonation slot), funds
// it (default + cross-cutting), registers `{name, address}`, and
// publishes a per-account resolved value via a uniquely-keyed Tag.
//
// User-facing factory shape:
//
//   account('alice')                                  // default ephemeral
//   account('alice', { kind: 'ephemeral', name: 'alice', fund: 5_000_000_000n })
//   account('alice', { kind: 'keystore', name: 'alice', path: '~/.sui/keystore', aliasOrAddress: 'alice' })
//   account('alice', { kind: 'env',      name: 'alice', key: 'ALICE_PRIVATE_KEY' })
//   account('alice', { kind: 'inline',   name: 'alice', privateKey: 'suiprivkey1...' })
//   account('alice', { kind: 'signer',   name: 'alice', signer: hardwareWallet })
//   account('alice', { kind: 'impersonate', name: 'alice', address: '0xabc...' })
//
// **Bare-form default**: `account('alice')` is shorthand for
//
//   { kind: 'ephemeral', name: 'alice', fund: DEFAULT_EPHEMERAL_FUND_MIST }
//
// Distilled-doc invariant (12-account.md "Make the bare-form auto-
// promotion to fork-impersonate funding discoverable"): on fork-
// runtime Sui, the default-funding pass internally promotes from
// "faucet POST" to "pay-from-seed-via-impersonate" because no
// faucet exists on a fork. The promotion is LOUD by default — we
// emit a `log.appended` event the first time the promotion fires
// (see `funding.ts`).
//
// The plugin emits THREE capability decls + an error-tag contribution:
//
//   1. Snapshotable        — secret-material subtree (ephemeral only).
//   2. Codegenable         — `account-map` bindings (name → address).
//   3. StrategyContributor — per-stack `account:<name>` registry entry.
//
// Plus `errorContributions: [{ errorTags: ACCOUNT_ERROR_TAGS }]` —
// harvested by the supervisor into the FormatterRegistry so the
// cascade formatter renders account-tagged failures with the right
// taxonomy header.

import { Effect } from 'effect';

import { capabilities } from '../../api/define-capabilities.ts';
import { consumeMembers } from '../../api/consume-members.ts';
import { defineNodePlugin } from '../../api/define-plugin.ts';
import { pluginErrorContributions, readConsumedTag } from '../../api/plugin-authoring.ts';
import { defineTag } from '../../api/tag.ts';
import { SpanAttr } from '../../substrate/runtime/observability/spans.ts';
import { IdentityContext, StackPathsService } from '../../substrate/runtime/paths.ts';
import { SuiTag } from '../sui/index.ts';

import { makeAccountCodegen, type AccountBindings } from './codegen.ts';
import { ACCOUNT_ERROR_TAGS } from './errors.ts';
import {
	DEFAULT_EPHEMERAL_FUND_MIST,
	type CoinMember,
	type CrossCuttingFundingEntry,
	type FundingCoinTags,
	type ProjectedFundingEntry,
} from './funding.ts';
import {
	makeAccountRegistryContribution,
	type AccountRegistryEntry,
	type AccountRegistryFunding,
} from './registry.ts';
import { makeAccountSnapshotable } from './snapshot.ts';
import {
	acquireAccount,
	type AccountAcquireContext,
	type AccountOptions,
	type AccountValue,
} from './service.ts';
import type { CoinValue } from '../coin/index.ts';

const accountErrorContributions = pluginErrorContributions(ACCOUNT_ERROR_TAGS);

// ---------------------------------------------------------------------------
// Tag construction
// ---------------------------------------------------------------------------

/** Per-account-instance tag. The substrate's tag id MUST be unique
 *  across the stack — we encode the account name as a literal-typed
 *  template literal so the compiler catches duplicate-name composes
 *  at the `defineDevstack` call site.
 *
 *  Distilled-doc invariant: tag id flows into the on-disk path, the
 *  manifest key, and container labels — the strict-charset name
 *  validation (in `service.ts`) protects all four call sites. */
export type AccountTagId<Name extends string> = `account/${Name}`;

const makeAccountTag = <Name extends string>(name: Name) =>
	defineTag<AccountTagId<Name>, AccountValue>(`account/${name}` as AccountTagId<Name>, 'account');

// ---------------------------------------------------------------------------
// User-facing factory
// ---------------------------------------------------------------------------

/** Construct the account plugin instance.
 *
 *  Variants — typed at the API boundary via the discriminated
 *  `AccountOptions` union. The factory's second arg is OPTIONAL —
 *  omitting it yields the bare-form default (ephemeral + default
 *  funding). Passing a non-matching `kind:` is a compile error
 *  thanks to the union's discriminator.
 *
 *  Distilled-doc invariant: the name is validated at the FACTORY
 *  boundary (not just at acquire time) so a typo surfaces
 *  immediately, not at runtime. */
/** Account `consumes:` shape — Sui (hard upstream for ordering) plus
 *  the per-coin-tag tuple projected from the user-supplied funding
 *  entries. Preserving each literal `coin:${Sym}` is load-bearing for
 *  the stack-composition `MissingProviders` check (mirrors wallet's
 *  account-tag projection — see `plugins/wallet/index.ts`). */
type AccountConsumes<Funding extends ReadonlyArray<CrossCuttingFundingEntry>> = readonly [
	typeof SuiTag,
	...FundingCoinTags<Funding>,
];

export const account = <
	const N extends string,
	const Funding extends ReadonlyArray<CrossCuttingFundingEntry> = readonly [],
>(
	name: N,
	opts?: AccountOptions & { readonly funding?: Funding },
) => {
	// Normalize bare-form to ephemeral default. The user-facing
	// `AccountOptions` union does not include "kind absent" — we
	// inject the default here so the rest of the body sees a
	// fully-discriminated value.
	const resolved: AccountOptions = opts === undefined ? { kind: 'ephemeral', name } : opts;
	// Defensive: if the user passed a different `name:` than the
	// outer factory arg, prefer the OUTER one (it drives the tag id).
	const opts2: AccountOptions = { ...resolved, name } as AccountOptions;

	const tag = makeAccountTag(name);

	// Pull the funding member tuple out of opts (may be undefined for
	// the bare form / variants without funding). `consumeMembers`
	// projects each member's `.provides` tag (preserving literal
	// `coin:${Sym}` ids for the stack-level `MissingProviders` check)
	// and pre-builds the `projectInScope` closure used inside `acquire`.
	const fundingEntries =
		(opts?.funding as ReadonlyArray<CrossCuttingFundingEntry> | undefined) ?? [];
	const fundingMembers: ReadonlyArray<CoinMember> = fundingEntries.map((e) => e.coin);
	const consumedFunding = consumeMembers(fundingMembers);
	const consumes = [SuiTag, ...consumedFunding.consumesTags] as unknown as AccountConsumes<Funding>;

	return defineNodePlugin({
		provides: tag,
		// Strict upstream declaration — distilled-doc invariant.
		// Sui is HARD; every funding `CoinMember` is also HARD (the
		// substrate's topological scheduler ensures the coin's
		// publish / registry-entry lands before account funding
		// dispatches against `coinType:<fullCoinType>`). Faucet stays
		// consumed via the StrategyRegistry (no direct dep edge, per
		// 11-faucet.md "Faucet is a true leaf").
		consumes,
		// Account is a value-producer (no long-lived server / container);
		// `leaf-one-shot` matches the lifecycle (acquire → ready → done
		// at scope close).
		kind: 'leaf-one-shot',
		rebootCost: 'cheap',
		acquire: (ctx) =>
			Effect.gen(function* () {
				// `ctx.get(tag)` widens when `Consumes` carries template-
				// literal-generic tag ids. `readConsumedTag` centralizes
				// the narrow cast for this substrate limitation.
				const sui = readConsumedTag(ctx, SuiTag);
				// Identity + on-disk runtime root come from the
				// supervisor-provided substrate context.
				const identity = yield* IdentityContext;
				const paths = yield* StackPathsService;

				// Project each funding entry's `CoinMember` to a
				// `{fullCoinType, amount}` projection. The §14 cast
				// lives inside `consumeMembers.projectInScope`; we map
				// resolved values back onto entries by index.
				const resolvedCoinValues = consumedFunding.projectInScope(ctx);
				const projectedFunding: ReadonlyArray<ProjectedFundingEntry> = fundingEntries.map(
					(entry, i) => ({
						fullCoinType: (resolvedCoinValues[i] as CoinValue).fullCoinType,
						amount: entry.amount,
					}),
				);

				const acquireCtx: AccountAcquireContext = {
					sui: {
						mode: sui.fork !== null ? 'fork' : 'local',
						chain: sui.chain,
						sdk: sui.sdk,
					},
					runtimeRoot: paths.stackRoot,
					app: identity.app,
					stack: identity.stack,
					emitAutoPromotionEvent: () =>
						Effect.logWarning('account funding auto-promoted for fork mode').pipe(
							Effect.annotateLogs({
								[SpanAttr.accountName]: name,
								[SpanAttr.accountFundingFrom]: 'faucet',
								[SpanAttr.accountFundingTo]: 'pay-from-seed-via-impersonate',
								[SpanAttr.suiMode]: 'fork',
							}),
						),
					projectedFunding,
				};
				return yield* acquireAccount(opts2, acquireCtx);
			}),
		// Dynamic capability factory — receives the resolved
		// `AccountValue` + acquire context AFTER `acquire` succeeds.
		// Lets snapshot + codegen + registry decls reference the
		// REAL address (and identity app/stack) — the static form
		// would force placeholder values for fields only known at
		// acquire time.
		errorContributions: accountErrorContributions,
		capabilities: (resolved, acquireCtx2) => {
			const realEntry: AccountRegistryEntry = {
				name,
				address: resolved.address,
				scheme: resolved.scheme,
				source: resolved.source,
				funding: fundingProjectionForOptions(opts2, fundingEntries),
			};
			const bindings: AccountBindings = {
				name,
				address: resolved.address,
				scheme: resolved.scheme,
				source: resolved.source,
			};
			const snapshot = makeAccountSnapshotable({
				accountName: name,
				variant: opts2.kind,
				app: acquireCtx2.identity.app,
				stack: acquireCtx2.identity.stack,
			});
			const codegen = makeAccountCodegen<N>({ name, resolved: bindings });
			const registry = makeAccountRegistryContribution<N>(
				realEntry as AccountRegistryEntry & { readonly name: N },
			);
			return capabilities(snapshot, codegen, registry);
		},
	});
};

const fundingProjectionForOptions = (
	opts: AccountOptions,
	fundingEntries: ReadonlyArray<CrossCuttingFundingEntry>,
): AccountRegistryFunding => {
	if (opts.kind === 'ephemeral') {
		const requestedMist = opts.fund ?? DEFAULT_EPHEMERAL_FUND_MIST;
		if (requestedMist > 0n) {
			return {
				status: 'funded',
				balanceMist: null,
				requestedMist: requestedMist.toString(),
			};
		}
		if (fundingEntries.length === 0) {
			return {
				status: 'skipped',
				balanceMist: null,
				requestedMist: requestedMist.toString(),
			};
		}
	}
	if (fundingEntries.length === 0) {
		return { status: 'skipped', balanceMist: null, requestedMist: null };
	}
	return { status: 'unknown', balanceMist: null, requestedMist: null };
};

// ---------------------------------------------------------------------------
// Re-exports for advanced callers (Coin, Wallet, Package)
// ---------------------------------------------------------------------------

export type { AccountOptions, AccountValue, TxResult } from './service.ts';
export type {
	AccountError,
	AccountAcquireError,
	AccountAcquirePhase,
	AccountSignError,
	AccountSignPhase,
	AccountVariantKind,
} from './errors.ts';
export { ACCOUNT_ERROR_TAGS } from './errors.ts';
export type {
	CoinMember,
	CrossCuttingFundingEntry,
	FundingCoinTags,
	ProjectedFunding,
	ProjectedFundingEntry,
} from './funding.ts';
export { DEFAULT_EPHEMERAL_FUND_MIST, SUI_FULL_COIN_TYPE } from './funding.ts';
export type { AccountBindings } from './codegen.ts';
export type {
	AccountRegistryEntry,
	AccountRegistryFunding,
	AccountRegistryKey,
} from './registry.ts';
export { accountRegistryKey } from './registry.ts';
export type { SyntheticImpersonationSigner } from './variants/impersonate.ts';
export type { SignatureScheme, ResolvedKeypair } from './keypair.ts';
