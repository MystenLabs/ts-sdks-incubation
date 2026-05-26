// PluginExpander — compose-time plugin-rewrite contract.
//
// Some plugins cannot know their final `dependsOn` tuple at their
// factory's call site because the relevant members are introduced
// LATER (positionally, to `defineDevstack(...)`). The wallet's
// `accounts: 'all'` mode is the canonical case: the wallet's hard
// ordering edge against every account member is required, but the
// wallet factory has no view of which accounts the user passes in.
//
// The fix is a compose-time rewrite: the plugin returns a PLACEHOLDER
// member carrying an expander hook at a substrate-owned well-known
// symbol; the composer detects the symbol, calls the expander with the
// full member tuple, and substitutes the result. This module owns
// that symbol + expander shape so the composer does not import any
// plugin module to perform the rewrite.
//
// Architecture (Plugin-author surface = user-surface): any plugin
// — built-in or custom — that needs this rewrite attaches the same
// substrate-owned symbol with the same expander shape. The composer
// dispatches uniformly; no per-plugin special-case lives in
// `api/define-devstack.ts`.
//
// Note: this is a COMPOSE-TIME hook, distinct from the runtime
// `CapabilitySinks` harvest path. Capability sinks dispatch
// contributions AFTER plugin acquire; expanders run BEFORE the
// supervisor sees the member list at all. Both surfaces are
// substrate-owned but they fire at different times.

import type { AnyPlugin } from '../substrate/plugin.ts';

/** Globally registered symbol the composer probes for on every
 *  member. `Symbol.for(...)` avoids leaking a `unique symbol` identity
 *  into inferred Stack types (TS2742). */
export const PLUGIN_EXPANDER: symbol = Symbol.for('@devstack/contracts/plugin-expander');

/** Compose-time expander closure. Receives the FULL composed-member
 *  tuple (post-dependency-closure expansion) and returns the member
 *  the composer should substitute for the placeholder. The substrate
 *  treats the closure opaquely — plugin authors interpret `members`
 *  through whatever filter matches their domain (the wallet picks
 *  members whose id starts with `account/`; a hypothetical role-based
 *  expander would pick members by `role` or by capability). */
export type PluginExpander = (members: ReadonlyArray<AnyPlugin>) => AnyPlugin;

/** Read the expander hook from a member. Returns `undefined` when no
 *  hook is attached — the composer leaves the member alone in that
 *  case. */
export const readPluginExpander = (member: AnyPlugin): PluginExpander | undefined => {
	const slot = (member as unknown as Record<symbol, unknown>)[PLUGIN_EXPANDER];
	return typeof slot === 'function' ? (slot as PluginExpander) : undefined;
};

/** Attach an expander hook to a placeholder member. The symbol is
 *  written as a value-level property only — plugin factories MUST NOT
 *  surface the hook on the member's TS return type or the symbol
 *  identity leaks into inferred Stack types. */
export const attachPluginExpander = (
	placeholder: AnyPlugin,
	expander: PluginExpander,
): void => {
	(placeholder as unknown as Record<symbol, unknown>)[PLUGIN_EXPANDER] = expander;
};

/**
 * Run every registered expander once. Iterates the member tuple, finds
 * placeholders carrying a `PluginExpander`, and substitutes each with
 * the expander's resolved member. Members without a hook pass through
 * unchanged.
 *
 * Returns the input array verbatim (zero allocation) when no member
 * carries an expander — the explicit-tuple path remains the common case.
 *
 * The composer is responsible for re-running `expandPluginDependencies`
 * after the substitution so the now-resolved dependency edges fold
 * into the closure correctly.
 */
export const runPluginExpanders = (
	members: ReadonlyArray<AnyPlugin>,
): ReadonlyArray<AnyPlugin> => {
	let hasAny = false;
	for (const m of members) {
		if (readPluginExpander(m) !== undefined) {
			hasAny = true;
			break;
		}
	}
	if (!hasAny) return members;

	return members.map((m) => {
		const expand = readPluginExpander(m);
		return expand === undefined ? m : expand(members);
	});
};

/** True when the placeholder + replacement form an expansion pair —
 *  same id, at least one side carries the expander hook. Used by the
 *  composer's duplicate-provider check to allow the "placeholder + its
 *  expanded form" pair (both share an id by construction). */
export const isPluginExpanderPair = (a: AnyPlugin, b: AnyPlugin): boolean =>
	a.id === b.id && (readPluginExpander(a) !== undefined || readPluginExpander(b) !== undefined);
