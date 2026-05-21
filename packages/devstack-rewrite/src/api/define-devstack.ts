// `defineDevstack` — flat-variadic form.
//
// Architecture § Programmable API + Tension 11. Accepts a variadic
// list of plugin members and an optional trailing options bag. The
// trailing bag is structurally distinguished from a member by the
// absence of the `MEMBER_BRAND` (runtime) / `MemberBrand` field (type
// level). Mode-narrowing on this form is OPT-IN: authors thread
// `network` per factory (e.g. `cluster.for(network).localCluster()`)
// or use `defineDevstackWith` for automatic threading.

import {
	type __MissingProvidersError,
	type AnyMember,
	MEMBER_BRAND,
	type MissingProviders,
} from '../substrate/plugin.ts';
import type { DevstackOptions, OptionsLike } from '../substrate/options.ts';
import type { Tag, TagIdOf } from '../substrate/tag.ts';
import type {
	GroupKey,
	IsUniformHash,
	LitSiblingKey,
	SiblingScope,
	__SiblingHashConflictError,
} from '../substrate/lifted-sibling.ts';
import type { WitnessRequiredBy, WitnessProvidedBy } from '../substrate/witness.ts';
import { sui } from '../plugins/sui/index.ts';
import {
	WALLET_EXPAND_ACCOUNTS_ALL,
	type WalletExpandAccountsAllExpander,
} from '../plugins/wallet/index.ts';
import type { WalletAccountMember } from '../plugins/wallet/index.ts';

// --- Type-level helpers -------------------------------------------------

/** Distinguish a member from an options bag at the type level. A
 *  member carries the `MemberBrand` (a unique-symbol field); an
 *  options bag does not. */
type IsMember<T> = T extends { readonly [MEMBER_BRAND]: true } ? true : false;

/** Members in the args tuple — every element minus a trailing options
 *  bag (if any). The peel preserves narrow tuple types. */
export type MembersOf<Args extends ReadonlyArray<unknown>> = Args extends readonly [
	...infer Init,
	infer Last,
]
	? IsMember<Last> extends true
		? Args extends ReadonlyArray<AnyMember>
			? Args
			: never
		: Init extends ReadonlyArray<AnyMember>
			? Init
			: never
	: readonly [];

// --- Auto-mount sui() (D1, api-surface-design.md §4) --------------------
//
// Aggressive convention: when any plugin in the member tuple consumes
// the `'sui'` tag and no member provides it, the composer prepends a
// default `sui()` to the member tuple. The user always opts out by
// supplying an explicit sui factory (`sui()`, `sui(...)`, `suiFor.*`).
//
// The L4 composer is allowed to name `sui` (api-surface-design.md P6:
// "substrate is name-blind; the surface is name-aware"). The substrate
// kernel does NOT mention sui anywhere — this knowledge lives one layer
// above, here in the composer.

/** Default `sui()` member type — the value the auto-mount injects. */
export type DefaultSuiMember = ReturnType<typeof sui>;

/** True iff some member in the tuple already provides the `'sui'`
 *  tag (any sui mode satisfies this — the substrate tags every sui
 *  variant with id `'sui'`). */
type ProvidesSuiTag<Members> =
	Members extends ReadonlyArray<unknown>
		? Members[number] extends { readonly provides: Tag<infer Id, unknown> }
			? 'sui' extends Id
				? true
				: false
			: false
		: false;

/** True iff some member in the tuple consumes the `'sui'` tag. */
type ConsumesSuiTag<Members> =
	Members extends ReadonlyArray<unknown>
		? Members[number] extends { readonly consumes: infer Cs }
			? Cs extends ReadonlyArray<{ readonly id: infer Id }>
				? 'sui' extends Id
					? true
					: false
				: false
			: false
		: false;

/** Conditionally prepend `DefaultSuiMember` to a member tuple. The
 *  user-passed Members shape is preserved verbatim when sui is already
 *  provided OR not needed; otherwise the auto-mounted sui member is
 *  prepended (matches the runtime injection — see `defineDevstack`
 *  body). */
export type WithAutoSui<Members extends ReadonlyArray<AnyMember>> =
	ProvidesSuiTag<Members> extends true
		? Members
		: ConsumesSuiTag<Members> extends true
			? readonly [DefaultSuiMember, ...Members]
			: Members;

/** Collect every sibling-key carried by a member tuple's
 *  `liftedSiblings` field, and the group-keys whose hashes conflict.
 *
 *  IMPORTANT (Phase-3 finding): intermediate type aliases that take a
 *  generic parameter erase the per-member literal `Siblings` generic
 *  via constraint widening. The dedup detection therefore inlines its
 *  whole chain into one type alias. Don't decompose this into smaller
 *  helpers without re-verifying the negative test still fires. */
type SiblingKeysOfInline<Members> =
	Members extends ReadonlyArray<unknown>
		? (Members[number] extends { readonly liftedSiblings?: infer Sibs } ? Sibs : never) extends
				| ReadonlyArray<infer S>
				| undefined
			? S
			: never
		: never;

type ConflictingGroups<Members> =
	Members extends ReadonlyArray<unknown>
		? (Members[number] extends { readonly liftedSiblings?: infer Sibs } ? Sibs : never) extends
				| ReadonlyArray<infer S>
				| undefined
			? S extends LitSiblingKey<string, string, SiblingScope, string>
				? IsUniformHash<GroupKey<S>, SiblingKeysOfInline<Members>> extends false
					? GroupKey<S>
					: never
				: never
			: never
		: never;

/** Collect witnesses required by any member's resolved value but not
 *  provided by any member in the same stack. */
type WitnessesRequired<Members> =
	Members extends ReadonlyArray<unknown>
		? WitnessRequiredBy<
				Members[number] extends { readonly provides: Tag<string, infer R> } ? R : never
			>
		: never;

type WitnessesProvided<Members> =
	Members extends ReadonlyArray<unknown>
		? WitnessProvidedBy<
				Members[number] extends { readonly provides: Tag<string, infer R> } ? R : never
			>
		: never;

type UnsatisfiedWitnesses<Members> = Exclude<
	WitnessesRequired<Members>,
	WitnessesProvided<Members>
>;

/** Branded structured error — Phase-3 finding #6. */
export interface __UnsatisfiedWitnessesError<W extends string> {
	readonly __unsatisfied_witnesses: W;
}

// --- Stack handle -------------------------------------------------------

/**
 * The compile-time stack handle. Carries:
 *  - the member tuple (narrow),
 *  - the union of tag ids it provides,
 *  - an opaque marker the orchestrator boot path consumes.
 *
 * The runtime value is a struct; orchestrators consume it through
 * the supervisor entry point.
 */
export interface Stack<Members extends ReadonlyArray<AnyMember>> {
	readonly _tag: 'Stack';
	readonly members: Members;
	readonly options: DevstackOptions;
	/** Phantom — preserves the union of provided ids for downstream
	 *  introspection. Covariant per the phantom-variance rule. */
	readonly _providedIds?: () => {
		[K in keyof Members]: TagIdOf<Members[K]['provides']>;
	}[number];
}

// --- Diagnostic gating --------------------------------------------------
//
// If `MissingProviders` or `ConflictingGroups` or `UnsatisfiedWitnesses`
// is non-empty, the call signature surfaces a branded structured error
// so the IDE diagnostic names the missing piece (Phase-3 finding #6 /
// architecture open question #11).

/** Validation gate. Resolves to `unknown` when every check passes
 *  (assignable to any `Args`); to a branded structured error
 *  otherwise (not assignable, surfacing the field name in the IDE).
 *  UNCONSTRAINED Members — every helper sidesteps constraint widening
 *  via an internal `Members extends ReadonlyArray<unknown> ? ... : never`
 *  shape (Phase-3 finding).
 *
 *  IMPORTANT: validation runs against the AUTO-MOUNTED member tuple
 *  (`WithAutoSui<Members>`) so a user-written `defineDevstack(alice)`
 *  doesn't surface a `MissingProviders<'sui'>` diagnostic when the
 *  composer would inject `sui()` at runtime. The auto-mount is the
 *  reason consumes-of-sui-only-but-no-explicit-sui compiles. */
export type ValidateArgs<Members> =
	Members extends ReadonlyArray<AnyMember>
		? WithAutoSui<Members> extends infer M
			? M extends ReadonlyArray<unknown>
				? [MissingProviders<M>] extends [never]
					? [ConflictingGroups<M>] extends [never]
						? [UnsatisfiedWitnesses<M>] extends [never]
							? unknown
							: __UnsatisfiedWitnessesError<UnsatisfiedWitnesses<M>>
						: __SiblingHashConflictError<ConflictingGroups<M>>
					: __MissingProvidersError<MissingProviders<M>>
				: never
			: never
		: never;

// --- Public surface -----------------------------------------------------

/**
 * Variadic devstack composer. The trailing options bag is detected
 * structurally — it has no `MEMBER_BRAND` field.
 *
 * Compile-time checks performed:
 *   - missing-provider: every `consumes` tag has a matching `provides`
 *     somewhere in the member set,
 *   - lifted-sibling dedup conflict: literal-hash siblings under the
 *     same `(plugin, kind, scope)` group must agree,
 *   - witness satisfaction: every `RequiresWitness<N>` is paired with
 *     a `ProvidesWitness<N>` on some member's resolved value.
 *
 * Validation surfaces at the PARAMETER (not the return type) — the
 * generic `Args` is constrained against a branded error type whose
 * field name names the missing piece (type-prototype finding #6,
 * architecture open question #11). Failed validation makes the
 * args type un-assignable, surfacing as the standard
 * "not assignable to parameter of type" diagnostic with the branded
 * error field visible in the IDE.
 */
export function defineDevstack<Args extends ReadonlyArray<AnyMember | OptionsLike>>(
	...args: Args & ValidateArgs<MembersOf<Args>>
): Stack<WithAutoSui<MembersOf<Args>>> {
	const last = args[args.length - 1];
	const hasOptionsTail =
		last !== undefined && typeof last === 'object' && last !== null && !(MEMBER_BRAND in last);

	const rawMembers = (hasOptionsTail ? args.slice(0, -1) : args) as ReadonlyArray<AnyMember>;
	const options = (hasOptionsTail ? (last as DevstackOptions) : {}) as DevstackOptions;

	const autoMounted = autoMountSui(rawMembers);
	const members = expandWalletAccountsAll(autoMounted);

	const stack: Stack<ReadonlyArray<AnyMember>> = {
		_tag: 'Stack',
		members,
		options,
	};

	return stack as unknown as Stack<WithAutoSui<MembersOf<Args>>>;
}

// --- Runtime auto-mount helper ------------------------------------------

/** Auto-mount `sui()` when any member consumes the `'sui'` tag and no
 *  member provides it. The runtime mirror of `WithAutoSui<Members>`:
 *  the type-level helper conditionally adds the sui member at the
 *  type, this function conditionally adds the live member at the
 *  value. Both pivot on the same `provides.id === 'sui'` /
 *  `consumes[i].id === 'sui'` predicate so the type and the runtime
 *  agree on what gets injected. */
export function autoMountSui(members: ReadonlyArray<AnyMember>): ReadonlyArray<AnyMember> {
	let providesSui = false;
	let consumesSui = false;
	for (const m of members) {
		if (m.provides.id === 'sui') {
			providesSui = true;
		}
		for (const c of m.consumes) {
			if (c.id === 'sui') {
				consumesSui = true;
			}
		}
	}
	if (providesSui || !consumesSui) {
		return members;
	}
	return [sui(), ...members];
}

// --- wallet `accounts: 'all'` expansion (D6, api-surface-design.md §4) --
//
// The wallet factory returns a placeholder member with a symbol-keyed
// expander hook when the user passes `accounts: 'all'`. The composer
// is the only place that knows the FULL stack member tuple at compose
// time (P6: "substrate is name-blind; the surface is name-aware") —
// so the expansion runs here, after auto-mount has finalised the
// tuple, before the runtime member array is handed to the supervisor.
//
// Without expansion, the wallet's `consumes` would stay `[SuiTag]` and
// the supervisor's topological scheduler would race account funding
// against `signTransaction` (the same `address-not-found` failure the
// explicit-tuple form's `consumes` list defends against).

function readExpandHook(m: AnyMember): WalletExpandAccountsAllExpander | undefined {
	const slot = (m as unknown as Record<symbol, unknown>)[WALLET_EXPAND_ACCOUNTS_ALL];
	return typeof slot === 'function' ? (slot as WalletExpandAccountsAllExpander) : undefined;
}

const ACCOUNT_TAG_PREFIX = 'account/';

/** Expand any `wallet({ accounts: 'all' })` placeholder member into a
 *  real wallet member whose `consumes` includes every account member's
 *  provided tag. Returns the input array verbatim when no expansion is
 *  needed (zero allocation on the common explicit-tuple path). */
export function expandWalletAccountsAll(
	members: ReadonlyArray<AnyMember>,
): ReadonlyArray<AnyMember> {
	let needsExpansion = false;
	for (const m of members) {
		if (readExpandHook(m) !== undefined) {
			needsExpansion = true;
			break;
		}
	}
	if (!needsExpansion) return members;

	const accountMembers: Array<WalletAccountMember> = [];
	for (const m of members) {
		if (m.provides.id.startsWith(ACCOUNT_TAG_PREFIX)) {
			accountMembers.push(m as WalletAccountMember);
		}
	}

	return members.map((m) => {
		const expand = readExpandHook(m);
		return expand === undefined ? m : expand(accountMembers);
	});
}
