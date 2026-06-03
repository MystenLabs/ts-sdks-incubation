// Account plugin — barrel + `account(name, opts?)` factory.
//
// Architecture (12-account.md): Account is the named-identity layer
// for devstack. It acquires a keypair (or impersonation slot), funds
// it (default + cross-cutting), registers `{name, address}`, and
// publishes a per-account resolved value via a unique resource id.
//
// User-facing factory shape:
//
//   account('alice')                                  // default ephemeral
//   account('alice', { kind: 'ephemeral', funding: [{ coin: 'sui', amount: 5_000_000_000n }] })
//   account('alice', { kind: 'keystore', path: '~/.sui/keystore', aliasOrAddress: 'alice' })
//   account('alice', { kind: 'env',      key: 'ALICE_PRIVATE_KEY' })
//   account('alice', { kind: 'inline',   privateKey: 'suiprivkey1...' })
//   account('alice', { kind: 'signer',   signer: hardwareWallet })
//   account('alice', { kind: 'impersonate', address: '0xabc...' })
//
// **Bare-form default**: `account('alice')` is shorthand for
//
//   { kind: 'ephemeral' } plus default SUI funding.
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

import { definePlugin, resource, type AnyResourceRef } from '../../api/define-plugin.ts';
import { pluginErrorContributions } from '../../api/plugin-errors.ts';
import type { PluginCtx } from '../../substrate/plugin-ctx.ts';
import { PluginContext } from '../../substrate/plugin-ctx.ts';
import { IdentityContext, StackPathsService } from '../../substrate/runtime/paths.ts';
import { suiResource, SuiSpans } from '../sui/index.ts';

import { AccountSpans } from './spans.ts';

import { makeAccountCodegen, type AccountBindings } from './codegen.ts';
import {
	ACCOUNT_ERROR_TAGS,
	accountAcquireError,
	type AccountAcquireError,
	type AccountVariantKind,
} from './errors.ts';
import {
	SUI_FULL_COIN_TYPE,
	type AccountFunding,
	type AccountFundingEntry,
	type AccountFundingResult,
	type CrossCuttingFundingEntry,
	type CrossCuttingFundingProvider,
	type CoinMember,
	type ProjectedFundingEntry,
} from './funding.ts';
import {
	makeAccountProjectionContribution,
	makeAccountRegistryContribution,
	type AccountRegistryEntry,
	type AccountRegistryFunding,
} from './registry.ts';
import { makeAccountSnapshotable } from './snapshot.ts';
import {
	acquireAccount,
	assertAccountName,
	type AccountAcquireContext,
	type AccountOptions,
	type ResolvedAccountOptions,
	type AccountValue,
} from './service.ts';

const accountErrorContributions = pluginErrorContributions(ACCOUNT_ERROR_TAGS);

// ---------------------------------------------------------------------------
// Resource construction
// ---------------------------------------------------------------------------

/** Per-account-instance resource. The substrate's resource id MUST be unique
 *  across the stack — we encode the account name as a literal-typed
 *  template literal so the compiler catches duplicate-name composes
 *  at the `defineDevstack` call site.
 *
 *  Distilled-doc invariant: resource id flows into the on-disk path, the
 *  manifest key, container labels, and generated TypeScript exports —
 *  the identifier-safe name validation (in `service.ts`) protects
 *  those call sites. */
export type AccountResourceId<Name extends string> = `account/${Name}`;

const accountResource = <Name extends string>(name: Name) =>
	resource<AccountResourceId<Name>, AccountValue>(`account/${name}` as AccountResourceId<Name>);

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
type FundingCoinDependencies<Entries extends readonly unknown[]> = Entries extends readonly [
	infer Head,
	...infer Tail,
]
	? Head extends { readonly coin: infer Coin }
		? Coin extends CoinMember
			? readonly [Coin, ...FundingCoinDependencies<Tail>]
			: FundingCoinDependencies<Tail>
		: FundingCoinDependencies<Tail>
	: readonly [];

type FundingProviderDependenciesFor<Provider> = Provider extends readonly AnyResourceRef[]
	? Provider
	: Provider extends AnyResourceRef
		? readonly [Provider]
		: readonly [];

type FundingEntryProviderDependencies<Entry> = Entry extends { readonly coin: CoinMember }
	? 'via' extends keyof Entry
		? Entry extends { readonly via: infer Provider }
			? FundingProviderDependenciesFor<Provider>
			: readonly []
		: readonly []
	: readonly [];

type FundingProviderDependencies<Entries extends readonly unknown[]> = Entries extends readonly [
	infer Head,
	...infer Tail,
]
	? readonly [...FundingEntryProviderDependencies<Head>, ...FundingProviderDependencies<Tail>]
	: readonly [];

type AccountDependencyMembers<Funding extends AccountFunding> = readonly [
	typeof suiResource,
	...FundingCoinDependencies<Funding>,
	...FundingProviderDependencies<Funding>,
];

const isCoinFundingEntry = (entry: AccountFundingEntry): entry is CrossCuttingFundingEntry =>
	typeof entry === 'object' && entry.coin !== 'sui';

const fundingProviders = (
	provider: CrossCuttingFundingProvider | undefined,
): ReadonlyArray<AnyResourceRef> => {
	if (provider === undefined) return [];
	return Array.isArray(provider)
		? (provider as ReadonlyArray<AnyResourceRef>)
		: [provider as AnyResourceRef];
};

/** Validate a SUI funding amount and project it to bigint MIST.
 *  Returns a typed-error Effect so a bad amount surfaces as
 *  `AccountAcquireError(phase: 'validate-funding')` on the failure
 *  channel — NOT a synchronous throw lifted to a defect when called
 *  from inside the acquire body's `Effect.gen`. */
const fundingAmountToBigInt = (
	amount: number | bigint,
	accountName: string,
): Effect.Effect<bigint, AccountAcquireError> => {
	if (typeof amount === 'bigint') {
		if (amount < 0n) {
			return Effect.fail(
				accountAcquireError({
					phase: 'validate-funding',
					accountName,
					variant: 'ephemeral',
					message: `Account '${accountName}': SUI funding amount must be a non-negative integer in MIST (got ${amount}).`,
				}),
			);
		}
		return Effect.succeed(amount);
	}
	if (!Number.isSafeInteger(amount) || amount < 0) {
		return Effect.fail(
			accountAcquireError({
				phase: 'validate-funding',
				accountName,
				variant: 'ephemeral',
				message: `Account '${accountName}': SUI funding amount must be a non-negative safe integer in MIST (got ${amount}).`,
			}),
		);
	}
	return Effect.succeed(BigInt(amount));
};

const coinLabelFor = (coin: { readonly fullCoinType: string; readonly symbol?: string }): string =>
	coin.symbol ?? coin.fullCoinType.split('::').at(-1) ?? coin.fullCoinType;

// ---------------------------------------------------------------------------
// Capability emission — dynamic (POST-acquire). Receives the resolved
// `AccountValue` + the identity so snapshot + codegen + registry + projection
// decls reference the REAL address (and identity app/stack) — the static form
// would force placeholder values for fields only known at acquire time.
//
// Stage B (plugin API inversion): `buildAccountCapabilities` stays a PURE
// helper that RETURNS the ordered decls; `start` emits them inline via the
// typed `ctx` verbs (`emitAccountCapabilities`) AFTER resolving the value,
// instead of the legacy `capabilities` second-closure. The decl shapes + emit
// ORDER (snapshot → codegen → registry → projection) are byte-identical to the
// closure path the supervisor used to harvest.
// ---------------------------------------------------------------------------

/** The inputs the capability emission needs beyond the resolved value:
 *  the literal account name, the resolved variant kind (snapshot scoping),
 *  and the identity (`app`/`stack`) for the snapshot pre-restore guard.
 *  These are the fields the legacy closure read off `runtime.identity` +
 *  the factory closure scope. */
interface AccountCapabilityInputs<Name extends string> {
	readonly name: Name;
	readonly variant: AccountVariantKind;
	readonly app: string;
	readonly stack: string;
}

/** Build the ordered capability decls for one resolved account. The return
 *  order — `[snapshot, codegen, registry, projection]` — is load-bearing:
 *  the supervisor's legacy `capabilities`-closure harvest replayed them in
 *  exactly this order, so `emitAccountCapabilities` routes each to its verb
 *  in the same sequence. */
const buildAccountCapabilities = <Name extends string>(
	resolved: AccountValue,
	inputs: AccountCapabilityInputs<Name>,
) => {
	const realEntry: AccountRegistryEntry = {
		name: inputs.name,
		address: resolved.address,
		scheme: resolved.scheme,
		source: resolved.source,
		funding: fundingProjectionForResult(resolved.funding),
	};
	const bindings: AccountBindings = {
		name: inputs.name,
		address: resolved.address,
		scheme: resolved.scheme,
		source: resolved.source,
	};
	const snapshot = makeAccountSnapshotable({
		accountName: inputs.name,
		variant: inputs.variant,
		app: inputs.app,
		stack: inputs.stack,
	});
	const codegen = makeAccountCodegen<Name>({ name: inputs.name, resolved: bindings });
	const registry = makeAccountRegistryContribution<Name>(
		realEntry as AccountRegistryEntry & { readonly name: Name },
	);
	const projection = makeAccountProjectionContribution<Name>(
		realEntry as AccountRegistryEntry & { readonly name: Name },
	);
	return [snapshot, codegen, registry, projection] as const;
};

/** Emit the pure decls from `buildAccountCapabilities` inline via the typed
 *  `ctx` verbs, routing each by its position IN RETURN ORDER (snapshotable →
 *  `ctx.snapshotExtra`, codegenable → `ctx.codegen`, strategy-contributor →
 *  `ctx.provides`, projection → `ctx.publish`). Order + decl shapes are
 *  byte-identical to the supervisor's legacy `capabilities`-closure harvest.
 *
 *  Exported as the Stage-B emit seam: this is the exact contribution-emit
 *  half of account's `start` (`start` = resolve `value` via `acquireAccount`,
 *  then `emitAccountCapabilities(ctx, value, inputs)`). It is the value-
 *  injection point the variants test drives — the old test called the now-
 *  removed `capabilities(value, …)` factory; the equivalent is to feed a
 *  resolved `AccountValue` here and assert the captured `provides`. */
export const emitAccountCapabilities = <Name extends string>(
	ctx: PluginCtx,
	resolved: AccountValue,
	inputs: AccountCapabilityInputs<Name>,
): void => {
	const [snapshot, codegen, registry, projection] = buildAccountCapabilities(resolved, inputs);
	ctx.snapshotExtra(snapshot);
	ctx.codegen(codegen);
	ctx.provides(registry);
	ctx.publish(projection);
};

export const account = <const N extends string, const Funding extends AccountFunding = readonly []>(
	name: N,
	opts?: AccountOptions<Funding>,
) => {
	assertAccountName(name);

	// Normalize bare-form to ephemeral default. The user-facing
	// `AccountOptions` union does not include "kind absent" — we
	// inject the default here so the rest of the body sees a
	// fully-discriminated value.
	const opts2: ResolvedAccountOptions =
		opts === undefined
			? { kind: 'ephemeral', name }
			: ({ ...opts, name } as ResolvedAccountOptions);

	const accountRef = accountResource(name);

	// Pull the funding resource tuple out of opts (may be undefined for
	// the bare form / variants without funding). The tuple preserves
	// plugin-valued refs when the caller passed coin plugins, so
	// recursive stack composition can include those publishers.
	const fundingEntries = (opts?.funding ?? []) as unknown as Funding;
	const fundingEntryList = fundingEntries as AccountFunding;
	const coinFundingEntries = fundingEntryList.filter(isCoinFundingEntry);
	const fundingMembers = coinFundingEntries.map((e) => e.coin);
	const strategyProviderMembers = coinFundingEntries.flatMap((entry) =>
		fundingProviders(entry.via),
	);
	const dependencies = [
		suiResource,
		...fundingMembers,
		...strategyProviderMembers,
	] as unknown as AccountDependencyMembers<Funding>;

	return definePlugin({
		id: accountRef.id,
		dependsOn: dependencies,
		// Account is a value-producer (no long-lived server / container);
		// tasks acquire their value, publish contributions, then reach
		// `done`.
		role: 'task',
		section: 'account',
		// `deps` auto-infers from the resolved `dependsOn`; `ctx` arrives
		// via the `PluginContext` service.
		start: (deps) =>
			Effect.gen(function* () {
				const ctx = yield* PluginContext;
				const [sui, ...resolvedDeps] = deps;
				const resolvedCoinValues = resolvedDeps.slice(
					0,
					coinFundingEntries.length,
				) as ReadonlyArray<{
					readonly fullCoinType: string;
					readonly symbol?: string;
				}>;
				// Identity + on-disk runtime root come from the
				// supervisor-provided substrate context.
				const identity = yield* IdentityContext;
				const paths = yield* StackPathsService;

				// Project each funding dependency value to a
				// `{fullCoinType, amount}` projection. Dependency order
				// mirrors `fundingEntries`, after the hard Sui upstream.
				// SUI amount validation lives on the failure channel so a
				// negative / non-integer amount surfaces as a typed
				// `AccountAcquireError(phase: 'validate-funding')` instead
				// of a defect (the old sync-throw lifted to a defect when
				// run inside this `Effect.gen`).
				let coinIndex = 0;
				const projectedFundingMutable: ProjectedFundingEntry[] = [];
				for (const entry of fundingEntryList) {
					if (entry.coin === 'sui') {
						const amount = yield* fundingAmountToBigInt(entry.amount, name);
						projectedFundingMutable.push({
							coin: 'SUI',
							fullCoinType: SUI_FULL_COIN_TYPE,
							amount,
						});
						continue;
					}
					const resolvedCoin = resolvedCoinValues[coinIndex]!;
					coinIndex += 1;
					projectedFundingMutable.push({
						coin: coinLabelFor(resolvedCoin),
						fullCoinType: resolvedCoin.fullCoinType,
						amount: entry.amount,
					});
				}
				const projectedFunding: ReadonlyArray<ProjectedFundingEntry> = projectedFundingMutable;

				const acquireCtx: AccountAcquireContext = {
					sui: {
						mode: sui.mode,
						chain: sui.chain,
						sdk: sui.sdk,
						fork: sui.fork,
					},
					runtimeRoot: paths.stackRoot,
					app: identity.app,
					stack: identity.stack,
					emitAutoPromotionEvent: () =>
						Effect.logWarning('account funding auto-promoted for fork mode').pipe(
							Effect.annotateLogs({
								[AccountSpans.name]: name,
								[AccountSpans.fundingFrom]: 'faucet',
								[AccountSpans.fundingTo]: 'pay-from-seed-via-impersonate',
								[SuiSpans.mode]: 'fork',
							}),
						),
					projectedFunding,
				};
				const resolved = yield* acquireAccount(opts2, acquireCtx);

				// Stage B (plugin API inversion): emit the resolved account's
				// contributions inline (was the `capabilities: ({ value, runtime
				// }) => [...]` second-closure). `resolved` is the just-acquired
				// `AccountValue`; the closure's `runtime.identity.{app,stack}`
				// are the same `identity` already in scope (both are the
				// substrate `Identity` — `runtime.identity` for the closure,
				// `yield* IdentityContext` here), and the variant kind is
				// `opts2.kind`. The snapshot/codegen/registry/projection decl
				// shapes + emit ORDER are byte-identical to the old closure.
				emitAccountCapabilities(ctx, resolved, {
					name,
					variant: opts2.kind,
					app: identity.app,
					stack: identity.stack,
				});

				return resolved;
			}),
		errorContributions: accountErrorContributions,
	});
};

/** @internal — exported only for the projection regression test
 *  (`test/plugins/account/funding-projection.test.ts`). Projects the runtime
 *  `AccountFundingResult` (requested + applied) into the registry's
 *  per-row funded/already-satisfied/skipped status. */
export const fundingProjectionForResult = (
	funding: AccountFundingResult,
): AccountRegistryFunding => {
	if (funding.requested.length === 0) {
		return { status: 'skipped', balanceMist: null, requestedMist: null, entries: [] };
	}

	// Positional outcome consume so the projection can distinguish a
	// real faucet call (`funded`) from the pre-existing-balance
	// short-circuit (`already-satisfied`). `applied` is an
	// order-preserving SUBSEQUENCE of `requested`:
	// `applyCrossCuttingFunding` (and the default-funding pass) iterate
	// `requested` in order and only push a processed entry onto
	// `applied`, dropping zero-amount and no-strategy entries. So we
	// walk a cursor through `applied` and adopt its outcome for the
	// matching requested row by (fullCoinType, amount) — a keyed Map
	// would collapse duplicate (coin, amount) entries and mislabel the
	// genuinely-funded first row as `already-satisfied`. An entry the
	// funding pass never reached (zero-amount, or absent from `applied`)
	// does not match the cursor and projects as `skipped` without
	// advancing it.
	let appliedCursor = 0;
	const entries = funding.requested.map((entry) => {
		const candidate = funding.applied[appliedCursor];
		const matches =
			candidate !== undefined &&
			candidate.fullCoinType === entry.fullCoinType &&
			candidate.amount === entry.amount;
		const outcome = matches ? candidate.outcome : undefined;
		if (matches) {
			appliedCursor += 1;
		}
		return {
			coin: entry.coin,
			fullCoinType: entry.fullCoinType,
			amount: entry.amount.toString(),
			status:
				outcome === 'funded'
					? ('funded' as const)
					: outcome === 'already-satisfied'
						? ('already-satisfied' as const)
						: ('skipped' as const),
		};
	});
	const requestedMist =
		funding.requested
			.find((entry) => entry.fullCoinType === SUI_FULL_COIN_TYPE)
			?.amount.toString() ?? null;
	const settledCount = entries.filter(
		(entry) => entry.status === 'funded' || entry.status === 'already-satisfied',
	).length;
	return {
		// `funded` here means "every requested entry is satisfied" —
		// either the faucet succeeded or the pre-existing balance
		// already covered it. `unknown` covers the mixed partial-success
		// case so consumers can distinguish from "nothing ran at all".
		status: settledCount === entries.length ? 'funded' : settledCount === 0 ? 'skipped' : 'unknown',
		balanceMist: null,
		requestedMist,
		entries,
	};
};

// ---------------------------------------------------------------------------
// Re-exports for advanced callers (Coin, Wallet, Package)
// ---------------------------------------------------------------------------

export type {
	AccountOptions,
	ResolvedAccountOptions,
	AccountValue,
	SignAndExecuteResult,
	TxResult,
} from './service.ts';
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
	AccountFunding,
	AccountFundingEntry,
	AccountFundingCoinValue,
	AccountFundingResult,
	AccountFundingRequest,
	AccountFundingStrategy,
	AppliedFunding,
	AppliedFundingEntry,
	AppliedFundingOutcome,
	CoinMember,
	CrossCuttingFundingEntry,
	CrossCuttingFundingProvider,
	FundEphemeralDefaultOutcome,
	ProjectedFunding,
	ProjectedFundingEntry,
	SuiFundingEntry,
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
export { AccountSpans } from './spans.ts';
