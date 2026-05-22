// `defineDevstack` — object-form stack composer.
//
// Listed members are entrypoints. Plugin-valued dependencies are
// expanded recursively before the engine sees the plugin list.

import {
	type __MissingProvidersError,
	type AnyPlugin,
	type MissingProviders,
	pluginDependencyRefs,
} from '../substrate/plugin.ts';
import type { DevstackOptions } from '../substrate/options.ts';
import {
	WALLET_EXPAND_ACCOUNTS_ALL,
	type WalletExpandAccountsAllExpander,
} from '../plugins/wallet/index.ts';
import type { WalletAccountMember } from '../plugins/wallet/index.ts';
import { isPlugin, type AnyResourceRef } from './define-plugin.ts';

// --- Type-level helpers -------------------------------------------------

const STACK_ENGINE = Symbol.for('@mysten-incubation/devstack.stack.engine');

type PluginDependencyMembers<Member> = Member extends {
	readonly dependsOn: ReadonlyArray<infer Dependency>;
}
	? Dependency extends AnyPlugin
		? Dependency
		: never
	: never;

type ReachableMember<Member, Seen extends string = never> = Member extends {
	readonly id: infer Id extends string;
}
	? Id extends Seen
		? never
		: Member | ReachableMember<PluginDependencyMembers<Member>, Seen | Id>
	: never;

export type DependencyClosure<Members extends ReadonlyArray<AnyPlugin>> = ReadonlyArray<
	Members[number] extends infer Member ? ReachableMember<Member> : never
>;

export type ComposedMembers<Members extends ReadonlyArray<AnyPlugin>> = DependencyClosure<Members>;

export interface DevstackConfig<Members extends ReadonlyArray<AnyPlugin>> extends DevstackOptions {
	readonly members: Members;
}

// --- Stack handle -------------------------------------------------------

/**
 * The compile-time stack handle. Carries:
 *  - the plugin tuple (narrow),
 *  - the union of resource ids it provides,
 *  - an opaque marker the orchestrator boot path consumes.
 *
 * The runtime value is a struct; orchestrators consume it through
 * the supervisor entry point.
 */
export interface Stack<Members extends ReadonlyArray<AnyPlugin> = ReadonlyArray<AnyPlugin>> {
	readonly _tag: 'Stack';
	readonly options: DevstackOptions;
	/** Phantom — preserves the union of provided ids for downstream
	 *  introspection. Covariant per the phantom-variance rule. */
	readonly _providedIds?: () => {
		[K in keyof Members]: Members[K]['id'];
	}[number];
}

export interface StackEngine<Members extends ReadonlyArray<AnyPlugin> = ReadonlyArray<AnyPlugin>> {
	readonly _tag: 'Stack';
	readonly members: Members;
	readonly options: DevstackOptions;
}

export const readStackEngine = <Members extends ReadonlyArray<AnyPlugin>>(
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
// If `MissingProviders` is non-empty, the call signature surfaces a
// branded structured error so the IDE diagnostic names the missing
// piece.

/** Validation gate. Resolves to `unknown` when every check passes
 *  (assignable to any `Args`); to a branded structured error
 *  otherwise (not assignable, surfacing the field name in the IDE).
 *  UNCONSTRAINED Members — every helper sidesteps constraint widening
 *  via an internal `Members extends ReadonlyArray<unknown> ? ... : never`
 *  shape (Phase-3 finding).
 *
 *  IMPORTANT: validation runs against the recursively expanded member
 *  tuple (`ComposedMembers<Members>`). Bare resource dependencies must
 *  have an explicit provider in the stack; plugin-valued dependencies
 *  are pulled in by the closure first. */
export type ValidateArgs<Members> =
	Members extends ReadonlyArray<AnyPlugin>
		? ComposedMembers<Members> extends infer M
			? M extends ReadonlyArray<unknown>
				? [MissingProviders<M>] extends [never]
					? unknown
					: __MissingProvidersError<MissingProviders<M>>
				: never
			: never
		: never;

// --- Public surface -----------------------------------------------------

/**
 * Object-form devstack composer.
 *
 * Compile-time checks performed:
 *   - missing-provider: every dependency id has a matching plugin id
 *     somewhere in the plugin set.
 *
 * Validation surfaces at the PARAMETER (not the return type) — the
 * generic `Args` is constrained against a branded error type whose
 * field name names the missing piece (type-prototype finding #6,
 * architecture open question #11). Failed validation makes the
 * config type un-assignable, surfacing as the standard
 * "not assignable to parameter of type" diagnostic with the branded
 * error field visible in the IDE.
 */
export function defineDevstack<const Members extends ReadonlyArray<AnyPlugin>>(
	config: DevstackConfig<Members> & ValidateArgs<Members>,
): Stack<ComposedMembers<Members>> {
	const roots = expandPluginDependencies(config.members);
	const expandedWallet = expandWalletAccountsAll(roots);
	const members = expandPluginDependencies(expandedWallet);
	const { members: _members, ...options } = config;
	void _members;

	const engine: StackEngine<ReadonlyArray<AnyPlugin>> = {
		_tag: 'Stack',
		members,
		options,
	};
	const stack: Stack<ReadonlyArray<AnyPlugin>> = {
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
	members: ReadonlyArray<AnyPlugin>,
): ReadonlyArray<AnyPlugin> => {
	const expanded: AnyPlugin[] = [];
	const seen = new Map<string, AnyPlugin>();
	const visiting = new Set<string>();

	const visit = (member: AnyPlugin) => {
		const id = member.id;
		const previous = seen.get(id);
		if (previous === member) {
			return;
		}
		if (previous !== undefined) {
			if (isExpandedWalletAlias(previous, member)) {
				return;
			}
			throw new Error(`Duplicate devstack provider for ${id}`);
		}
		if (visiting.has(id)) {
			throw new Error(`Circular devstack dependency through ${id}`);
		}

		visiting.add(id);
		if (isPlugin(member)) {
			for (const dependency of pluginDependencyRefs(member) as readonly AnyResourceRef[]) {
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

const isExpandedWalletAlias = (a: AnyPlugin, b: AnyPlugin): boolean =>
	a.id === b.id && (readExpandHook(a) !== undefined || readExpandHook(b) !== undefined);

// --- wallet `accounts: 'all'` expansion (D6, api-surface-design.md §4) --
//
// The wallet factory returns a placeholder member with a symbol-keyed
// expander hook when the user passes `accounts: 'all'`. The composer
// is the only place that knows the FULL stack member tuple at compose
// time, so the expansion runs here before the runtime member array is
// handed to the supervisor.
//
// Without expansion, the wallet's dependencies would stay `[suiResource]` and
// the supervisor's topological scheduler would race account funding
// against `signTransaction`.

function readExpandHook(m: AnyPlugin): WalletExpandAccountsAllExpander | undefined {
	const slot = (m as unknown as Record<symbol, unknown>)[WALLET_EXPAND_ACCOUNTS_ALL];
	return typeof slot === 'function' ? (slot as WalletExpandAccountsAllExpander) : undefined;
}

const ACCOUNT_RESOURCE_PREFIX = 'account/';

/** Expand any `wallet({ accounts: 'all' })` placeholder plugin into a
 *  real wallet plugin whose dependencies include every account plugin.
 *  Returns the input array verbatim when no expansion is
 *  needed (zero allocation on the common explicit-tuple path). */
export function expandWalletAccountsAll(
	members: ReadonlyArray<AnyPlugin>,
): ReadonlyArray<AnyPlugin> {
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
		if (m.id.startsWith(ACCOUNT_RESOURCE_PREFIX)) {
			accountMembers.push(m as unknown as WalletAccountMember);
		}
	}

	return members.map((m) => {
		const expand = readExpandHook(m);
		return expand === undefined ? m : expand(accountMembers);
	});
}
