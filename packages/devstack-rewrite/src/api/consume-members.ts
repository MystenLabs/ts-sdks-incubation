// Plugin-authoring helper — collapses the "consume + project" pattern.
//
// Three built-in plugins (wallet, account, walrus) wire user-supplied
// member tuples into their `consumes:` shape AND walk the same tuple
// inside `acquire` to read each member's resolved value. Each call
// site had the same three pieces of scaffolding:
//
//   1. `members.map((m) => m.provides)` — project to tag tuple.
//   2. `[ProtocolTag, ...tags] as ...` — splice into `consumes`.
//   3. A localized typed cast (`ctx as { use: (m) => Resolved }`)
//      walking `members.map((m) => useMember(m))` — STYLE_GUIDE §14
//      (the substrate's `__MemberNotConsumedError` conditional does
//      NOT reduce while the upstream's tag id is a template-literal
//      generic like `account/${P}` or `coin:${Sym}`; pending Open
//      slot O10 / a distributive form on the `use` signature).
//
// Wherever the only reason a plugin reaches for the §14 cast is to
// project resolved values for a tuple of upstream members, this
// helper hides the cast inside one place and gives the call site:
//
//   - `consumesTags` to splice into the `consumes:` tuple.
//   - `projectInScope(ctx)` to read resolved values inside `acquire`.
//
// The single typed cast lives here — call sites stop repeating it.

import type { BuildContext, StackMember } from '../substrate/plugin.ts';
import type { AnyTag, ResolvedOf } from '../substrate/tag.ts';

/** Tuple-projection: per-member `provides` tag, preserving each
 *  member's literal-typed tag (`account/alice` etc.) so the surrounding
 *  `consumes:` keeps its narrow ids and the stack-level
 *  `MissingProviders` check fires at compose time when a referenced
 *  member is not in the stack. */
export type ConsumesTagsOf<
	Members extends ReadonlyArray<StackMember<AnyTag, ReadonlyArray<AnyTag>>>,
> = {
	readonly [K in keyof Members]: Members[K]['provides'];
};

/** Tuple-projection: per-member resolved-value type. Mirrors the shape
 *  `ctx.use(member)` returns for each entry. */
export type ResolvedValuesOf<
	Members extends ReadonlyArray<StackMember<AnyTag, ReadonlyArray<AnyTag>>>,
> = {
	readonly [K in keyof Members]: ResolvedOf<Members[K]['provides']>;
};

/** Return shape of `consumeMembers`. */
export interface ConsumedMembers<
	Members extends ReadonlyArray<StackMember<AnyTag, ReadonlyArray<AnyTag>>>,
> {
	/** `members.map(m => m.provides)` with the per-member literal tag
	 *  type preserved. Splice into the surrounding `consumes:` tuple. */
	readonly consumesTags: ConsumesTagsOf<Members>;
	/** Read the resolved value for each member inside an `acquire`
	 *  body. The localized §14 cast is hidden here — call sites take
	 *  the resolved tuple directly. */
	readonly projectInScope: (ctx: BuildContext<AnyTag>) => ResolvedValuesOf<Members>;
}

/**
 * Collapse the "consume + project" scaffolding around a tuple of
 * user-supplied member refs.
 *
 * @example
 * ```ts
 * const accounts = consumeMembers(opts.accounts);
 * const consumes = [SuiTag, ...accounts.consumesTags] as const;
 *
 * acquire: (ctx) => Effect.gen(function* () {
 *   const resolved = accounts.projectInScope(ctx);
 *   // resolved is ReadonlyArray<AccountValue> — typed end-to-end.
 * });
 * ```
 */
export const consumeMembers = <
	const Members extends ReadonlyArray<StackMember<AnyTag, ReadonlyArray<AnyTag>>>,
>(
	members: Members,
): ConsumedMembers<Members> => {
	const consumesTags = members.map((m) => m.provides) as unknown as ConsumesTagsOf<Members>;

	const projectInScope = (ctx: BuildContext<AnyTag>): ResolvedValuesOf<Members> => {
		// One localized §14 cast — see STYLE_GUIDE §14 + Open slot O10.
		// The substrate's `__MemberNotConsumedError` conditional doesn't
		// reduce while the upstream tag id is a template-literal generic
		// (`account/${P}`, `coin:${Sym}`, etc.). Hiding the cast here is
		// the helper's whole reason to exist — call sites no longer repeat
		// `ctx as { use: (m: M) => ResolvedOf<M['provides']> }`.
		const useMember = (ctx as { readonly use: (m: Members[number]) => unknown }).use;
		return members.map((m) => useMember(m)) as unknown as ResolvedValuesOf<Members>;
	};

	return { consumesTags, projectInScope };
};

/** Return shape of `consumeMember` — scalar variant of `ConsumedMembers`. */
export interface ConsumedMember<M extends StackMember<AnyTag, ReadonlyArray<AnyTag>>> {
	/** `member.provides` with its literal tag type preserved. Splice
	 *  into the surrounding `consumes:` tuple. */
	readonly consumesTag: M['provides'];
	/** Read the resolved value for the member inside an `acquire` body.
	 *  The localized §14 cast is hidden here — call sites take the
	 *  resolved value directly. */
	readonly projectInScope: (ctx: BuildContext<AnyTag>) => ResolvedOf<M['provides']>;
}

/**
 * Scalar companion to `consumeMembers` — collapses the same
 * "consume + project" scaffolding around a single user-supplied
 * member ref.
 *
 * Four built-in plugins (coin, package, seal, action) thread a single
 * upstream member ref (publisher / signer / package) and repeat the
 * §14 localized `ctx as { use: (m: typeof opts.X) => Value }` cast at
 * the call site. This helper hides the cast inside one place.
 *
 * @example
 * ```ts
 * const publisher = consumeMember(opts.publisher);
 * const consumes = [SuiTag, publisher.consumesTag] as const;
 *
 * acquire: (ctx) => Effect.gen(function* () {
 *   const account = publisher.projectInScope(ctx); // typed AccountValue
 * });
 * ```
 */
export const consumeMember = <const M extends StackMember<AnyTag, ReadonlyArray<AnyTag>>>(
	member: M,
): ConsumedMember<M> => {
	const projectInScope = (ctx: BuildContext<AnyTag>): ResolvedOf<M['provides']> => {
		// Same localized §14 cast as `consumeMembers` — centralised here.
		const useMember = (ctx as { readonly use: (m: M) => unknown }).use;
		return useMember(member) as ResolvedOf<M['provides']>;
	};

	return { consumesTag: member.provides, projectInScope };
};
