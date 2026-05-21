// `defineDevstackWith` — callback form.
//
// Architecture § Programmable API: the canonical surface when one or
// more composites need mode-narrowing. The callback receives a
// `BuildCtx` whose `network` is the resolved-narrow `NetworkConfig`;
// plugin-author factories that take `(network)` recover the mode
// discriminator structurally, and the compiler refuses illegal-mode
// factory access at the call site.

import { MEMBER_BRAND, type AnyMember } from '../substrate/plugin.ts';
import type { DevstackOptions } from '../substrate/options.ts';
import type { NetworkConfig, NetworkMode } from '../substrate/network.ts';
import type { __MissingProvidersError, MissingProviders } from '../substrate/plugin.ts';
import type {
	GroupKey,
	IsUniformHash,
	LitSiblingKey,
	SiblingScope,
	__SiblingHashConflictError,
} from '../substrate/lifted-sibling.ts';
import {
	autoMountSui,
	type Stack,
	type WithAutoSui,
	type __UnsatisfiedWitnessesError,
} from './define-devstack.ts';
import type { Tag } from '../substrate/tag.ts';
import type { WitnessProvidedBy, WitnessRequiredBy } from '../substrate/witness.ts';

// --- Callback context ---------------------------------------------------

/**
 * Build context handed to the callback. The `network` field carries
 * the resolved-narrow `NetworkConfig`; mode-narrowed factories that
 * take `(network)` recover the discriminator at the type level.
 */
export interface BuildCtx<Mode extends NetworkMode> {
	readonly network: NetworkConfig<Mode>;
}

/** Options bag for the callback form. `network` MUST be present so the
 *  callback's `BuildCtx` is typed. */
export interface DevstackOptionsWith<Mode extends NetworkMode> extends DevstackOptions {
	readonly network: NetworkConfig<Mode>;
}

// --- Type-level validation (mirrors flat form) --------------------------

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

/** Validation gate. Mirrors the flat-form rule: resolves to the
 *  caller's `Members` tuple on a clean check, branded error
 *  otherwise.
 *
 *  Validation runs against the auto-mounted tuple
 *  (`WithAutoSui<Members>`) so a builder returning
 *  `[account('alice')]` (no explicit sui) doesn't surface
 *  `MissingProviders<'sui'>` — the composer injects `sui()` at the
 *  call's tail. See `define-devstack.ts` D1 / api-surface-design.md §4. */
type ValidateBuild<Members> =
	Members extends ReadonlyArray<AnyMember>
		? WithAutoSui<Members> extends infer M
			? M extends ReadonlyArray<unknown>
				? [MissingProviders<M>] extends [never]
					? [ConflictingGroups<M>] extends [never]
						? [UnsatisfiedWitnesses<M>] extends [never]
							? Members
							: __UnsatisfiedWitnessesError<UnsatisfiedWitnesses<M>>
						: __SiblingHashConflictError<ConflictingGroups<M>>
					: __MissingProvidersError<MissingProviders<M>>
				: never
			: never
		: never;

// --- Public surface -----------------------------------------------------

/**
 * Callback-form devstack composer. The first arg is the options bag
 * (including the mode-narrow `network`); the second is a builder that
 * receives a `BuildCtx<Mode>` and returns the member tuple.
 *
 * The `Mode` generic is inferred from `options.network.mode`; the
 * callback's `BuildCtx` carries it, and plugin factories that accept
 * the narrowed network see the matching branch only.
 */
export function defineDevstackWith<
	Mode extends NetworkMode,
	Members extends ReadonlyArray<AnyMember>,
>(
	options: DevstackOptionsWith<Mode>,
	build: (ctx: BuildCtx<Mode>) => ValidateBuild<Members>,
): Stack<WithAutoSui<Members>> {
	const rawMembers = build({ network: options.network }) as ReadonlyArray<AnyMember>;

	// Defensive runtime check: every element returned by the builder
	// must carry the `MEMBER_BRAND`. Type system enforces this, but a
	// runtime check guards against `as unknown as AnyMember` casts.
	for (const m of rawMembers) {
		if (!(MEMBER_BRAND in (m as object))) {
			throw new Error(
				'defineDevstackWith: builder returned a value that is not a plugin member ' +
					'(missing MEMBER_BRAND). Did you forget to wrap with defineNodePlugin?',
			);
		}
	}

	const members = autoMountSui(rawMembers);

	const stack: Stack<ReadonlyArray<AnyMember>> = {
		_tag: 'Stack',
		members,
		options,
	};

	return stack as unknown as Stack<WithAutoSui<Members>>;
}
