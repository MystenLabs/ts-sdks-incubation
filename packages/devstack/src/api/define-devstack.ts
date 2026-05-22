// `defineDevstack` — object-form stack composer.
//
// Listed members are entrypoints. Plugin-valued dependencies are
// expanded recursively before the current engine sees the member list.

import {
	type __MissingProvidersError,
	type AnyMember,
	type MissingProviders,
} from '../substrate/plugin.ts';
import type { DevstackOptions } from '../substrate/options.ts';
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
import { isPlugin, type AnyResourceRef } from './define-plugin.ts';

// --- Type-level helpers -------------------------------------------------

const STACK_ENGINE = Symbol.for('@mysten-incubation/devstack.stack.engine');

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

type PluginDependencyMembers<Member> =
	Member extends { readonly dependsOn: ReadonlyArray<infer Dependency> }
		? Dependency extends AnyMember
			? Dependency
			: never
		: never;

type ReachableMember<Member, Seen extends string = never> =
	Member extends { readonly provides: Tag<infer Id, unknown> }
		? Id extends Seen
			? never
			: Member | ReachableMember<PluginDependencyMembers<Member>, Seen | Id>
		: never;

export type DependencyClosure<Members extends ReadonlyArray<AnyMember>> = ReadonlyArray<
	Members[number] extends infer Member ? ReachableMember<Member> : never
>;

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

export type ComposedMembers<Members extends ReadonlyArray<AnyMember>> = WithAutoSui<
	DependencyClosure<Members>
>;

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

export interface DevstackConfig<Members extends ReadonlyArray<AnyMember>> extends DevstackOptions {
	readonly members: Members;
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
	readonly options: DevstackOptions;
	/** Phantom — preserves the union of provided ids for downstream
	 *  introspection. Covariant per the phantom-variance rule. */
	readonly _providedIds?: () => {
		[K in keyof Members]: TagIdOf<Members[K]['provides']>;
	}[number];
}

export interface StackEngine<Members extends ReadonlyArray<AnyMember> = ReadonlyArray<AnyMember>> {
	readonly _tag: 'Stack';
	readonly members: Members;
	readonly options: DevstackOptions;
}

export const readStackEngine = <Members extends ReadonlyArray<AnyMember>>(
	stack: Stack<Members>,
): StackEngine<Members> => {
	const engine = (stack as unknown as Readonly<Record<symbol, StackEngine<Members> | undefined>>)[
		STACK_ENGINE
	];
	if (engine === undefined) {
		throw new Error('Invalid devstack Stack handle: missing internal engine stack');
	}
	return engine;
};

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
		? ComposedMembers<Members> extends infer M
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
 * Object-form devstack composer.
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
 * config type un-assignable, surfacing as the standard
 * "not assignable to parameter of type" diagnostic with the branded
 * error field visible in the IDE.
 */
export function defineDevstack<const Members extends ReadonlyArray<AnyMember>>(
	config: DevstackConfig<Members> & ValidateArgs<Members>,
): Stack<ComposedMembers<Members>> {
	const roots = expandPluginDependencies(config.members);
	const autoMounted = autoMountSui(roots);
	const expandedWallet = expandWalletAccountsAll(autoMounted);
	const members = expandPluginDependencies(expandedWallet);
	const { members: _members, ...options } = config;
	void _members;

	const engine: StackEngine<ReadonlyArray<AnyMember>> = {
		_tag: 'Stack',
		members,
		options,
	};
	const stack: Stack<ReadonlyArray<AnyMember>> = {
		_tag: 'Stack',
		options,
	};
	Object.defineProperty(stack, STACK_ENGINE, {
		value: engine,
		enumerable: false,
		configurable: false,
		writable: false,
	});

	return stack as unknown as Stack<ComposedMembers<Members>>;
}

export const expandPluginDependencies = (
	members: ReadonlyArray<AnyMember>,
): ReadonlyArray<AnyMember> => {
	const expanded: AnyMember[] = [];
	const seen = new Map<string, AnyMember>();
	const visiting = new Set<string>();

	const visit = (member: AnyMember) => {
		const id = member.provides.id;
		const previous = seen.get(id);
		if (previous === member) {
			return;
		}
		if (previous !== undefined) {
			throw new Error(`Duplicate devstack provider for ${id}`);
		}
		if (visiting.has(id)) {
			throw new Error(`Circular devstack dependency through ${id}`);
		}

		visiting.add(id);
		if (isPlugin(member)) {
			for (const dependency of member.dependsOn as readonly AnyResourceRef[]) {
				if (isPlugin(dependency)) {
					visit(dependency);
				}
			}
		}
		visiting.delete(id);
		seen.set(id, member);
		expanded.push(member);
	};

	for (const member of members) {
		visit(member);
	}

	return expanded;
};

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
