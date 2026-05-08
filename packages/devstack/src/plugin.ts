// `definePlugin()` — identity helper for typed plugin authoring.
//
// `expandPluginActions(plugins)` runs each plugin's actions callback,
// auto-prefixes bare action names with the plugin's namespace
// (`<plugin>.<name>`), and resolves bare-name `needs:` entries to the
// same local-prefixed form. Cross-plugin references stay fully
// qualified; capability queries (`<cap>:before`) are passed through to
// the topo sorter unchanged.

import type {
	AccountNames,
	AccountSpec,
	Action,
	DevstackConfig,
	DevstackConfigInput,
	Plugin,
} from './core/types.js';

const PLUGIN_NAME_RE = /^[a-z][a-z0-9_-]*$/;

/**
 * Brand stamped on the synthetic `<app>-setup` plugin built by
 * `defineDevstackConfig`. `expandPluginActions` lets the synthesizer
 * past the `-setup` reserved-suffix check (which `definePlugin` enforces
 * for user-defined plugins) only when the brand is present. A third
 * party can't forge it without importing this module's symbol — they'd
 * still be able to attach an own-named symbol property, but the
 * identity check is by reference, not by description.
 */
const SYNTHESIZED = Symbol('devstack.synthesized-plugin');

export function definePlugin<TProvides extends string = string>(
	plugin: Plugin<TProvides>,
): Plugin<TProvides> {
	validateUserPluginName(plugin.name);
	return plugin;
}

/**
 * Extract every action-name string a `use:` array (or any flat-or-nested
 * `Plugin | Action` collection) provides. Used by
 * `defineDevstackConfig` to type-check `needs:` references against the
 * plugins actually present in the surrounding config.
 *
 * Plugins contribute their `TProvides` union; bare setup actions
 * currently contribute nothing at the type level (their names live in a
 * synthetic `<app>-setup` plugin and are validated locally at runtime).
 *
 * Unannotated plugins (`Plugin<string>`, the default) contribute the
 * non-widening `string & {}` — TS keeps the annotated siblings' string
 * literals visible in autocomplete (instead of collapsing the union to
 * just `string`) while still accepting any string at the position. As
 * each plugin gets annotated, the union tightens and unknown strings
 * start producing TS errors. This is the "graceful degradation" mode
 * during the transitional period where not every plugin advertises
 * what it provides.
 */
export type ProvidedBy<TUse extends ReadonlyArray<unknown>> = TUse[number] extends infer Entry
	? Entry extends ReadonlyArray<unknown>
		? ProvidedBy<Entry>
		: Entry extends Plugin<infer P>
			? string extends P
				? string & {}
				: P
			: never
	: never;

/**
 * Extract every dotted (`'<plugin>.<action>'`) `needs:` reference any
 * setup action in the use array declares. Bare-name needs (local
 * references inside the synthetic `<app>-setup` plugin) are excluded —
 * those resolve at runtime against sibling setup actions and don't
 * need cross-array validation.
 *
 * Capability queries (`<plugin>.<cap>:before`) are also excluded: the
 * topo sorter treats them as soft-deps that drop cleanly when no
 * plugin in `use:` provides the capability (e.g. `walrus.app-network:before`
 * on `sui.localnet` is a hint that walrus *should* run first, but
 * sui happily proceeds when walrus isn't loaded). Validating them at
 * the type level would force every consumer to add walrus to `use:`
 * just to reference a capability that may not even exist — defeats
 * the soft-dep design.
 */
type DottedNeedsIn<TUse extends ReadonlyArray<unknown>> = TUse[number] extends infer Entry
	? Entry extends ReadonlyArray<unknown>
		? DottedNeedsIn<Entry>
		: Entry extends { __needs?: infer N }
			? N extends `${string}.${string}`
				? N extends `${string}:before`
					? never
					: N
				: never
			: never
	: never;

/**
 * Constraint for `defineDevstackConfig`'s `accounts:` field that
 * preserves literal-string inference on both forms (array of strings
 * vs. record-of-AccountSpec). Used as the upper bound on the
 * `TAccountsField` generic so the user's actual `accounts:` value
 * narrows TAccountsField to its literal shape — `AccountNames<...>`
 * then extracts the union of names.
 */
type AccountsFieldShape = ReadonlyArray<string> | Record<string, AccountSpec>;

/**
 * Extract the union of `__signsAs` literals declared on setup-action
 * factory returns (`runTransaction({ signer })`, `seed({ runsAs })`,
 * `publishMove({ publisher })`). `defineDevstackConfig` validates this
 * union is a subset of `accounts:`'s declared names so a typo on
 * `signer:` / `runsAs:` / `publisher:` surfaces at the
 * `defineDevstackConfig({ use: [...] })` call site rather than at
 * runtime as a "no factory configured" or "unknown account" error.
 *
 * Plugin-emitted actions don't carry `__signsAs`, so they contribute
 * `never` and don't constrain `accounts:`. Setup-action factories that
 * don't set the relevant field default the type variable to `never`
 * which also drops out of the union.
 */
type SignsAsIn<TUse extends ReadonlyArray<unknown>> = TUse[number] extends infer Entry
	? Entry extends ReadonlyArray<unknown>
		? SignsAsIn<Entry>
		: Entry extends { __signsAs?: infer S }
			? S extends string
				? S
				: never
			: never
	: never;

/**
 * Extract the union of `__publishesPackage` literals declared on
 * `publishMove({ name, registryAs })` setup-action returns. Used as
 * the upper bound for `__registerCoinFrom` validation in `ValidateUse`
 * — `registerCoin({ from: 'X' })` is rejected when X isn't a member
 * of this union.
 */
type PublishedPackagesIn<TUse extends ReadonlyArray<unknown>> = TUse[number] extends infer Entry
	? Entry extends ReadonlyArray<unknown>
		? PublishedPackagesIn<Entry>
		: Entry extends { __publishesPackage?: infer P }
			? P extends string
				? P
				: never
			: never
	: never;

/**
 * Extract the union of `__publishesRegistryAs` literals declared on
 * `publishMove({ registryAs })` setup-action returns (defaults to
 * `name` when `registryAs` is unset). Used as the upper bound for
 * `__registerCoinPackage` validation in `ValidateUse` —
 * `registerCoin({ package: 'X' })` is rejected when X isn't a member
 * of this union.
 */
type PublishedRegistryAsIn<TUse extends ReadonlyArray<unknown>> = TUse[number] extends infer Entry
	? Entry extends ReadonlyArray<unknown>
		? PublishedRegistryAsIn<Entry>
		: Entry extends { __publishesRegistryAs?: infer R }
			? R extends string
				? R
				: never
			: never
	: never;

/**
 * Extract the union of `__registerCoinFrom` literals declared on
 * `registerCoin({ from })` setup-action returns. Used by `ValidateUse`
 * to verify that every `from:` value names a sibling `publishMove`'s
 * declared package (`name` or `registryAs`).
 */
type RegisterCoinFromIn<TUse extends ReadonlyArray<unknown>> = TUse[number] extends infer Entry
	? Entry extends ReadonlyArray<unknown>
		? RegisterCoinFromIn<Entry>
		: Entry extends { __registerCoinFrom?: infer F }
			? F extends string
				? F
				: never
			: never
	: never;

/**
 * Extract the union of `__registerCoinPackage` literals declared on
 * `registerCoin({ package })` setup-action returns. Used by
 * `ValidateUse` to verify that every `package:` value names a sibling
 * `publishMove`'s registry key (`registryAs` or its `name` default).
 */
type RegisterCoinPackagesIn<TUse extends ReadonlyArray<unknown>> = TUse[number] extends infer Entry
	? Entry extends ReadonlyArray<unknown>
		? RegisterCoinPackagesIn<Entry>
		: Entry extends { __registerCoinPackage?: infer P }
			? P extends string
				? P
				: never
			: never
	: never;

/**
 * Validation: returns `TUse` if every check passes. Four layered checks
 * (innermost first; the first failure surfaces at the call site):
 *
 *   1. Every dotted `needs:` reference matches a `Plugin<TProvides>`
 *      provides string in the same array.
 *   2. Every `__signsAs` literal (from `runTransaction({signer})`,
 *      `seed({runsAs})`, `publishMove({publisher})`) matches a declared
 *      account name.
 *   3. Every `__registerCoinFrom` literal (from `registerCoin({from})`)
 *      matches a `__publishesPackage` literal — i.e. a sibling
 *      `publishMove({name})` actually publishes that key.
 *   4. Every `__registerCoinPackage` literal (from
 *      `registerCoin({package})`) matches a `__publishesRegistryAs`
 *      literal — i.e. a sibling `publishMove({registryAs})` actually
 *      publishes that registry key.
 *
 * Otherwise returns a branded error string that surfaces as a `Type 'X'
 * is not assignable to type 'Error: ...'` message at the call site.
 */
type ValidateUse<
	TUse extends ReadonlyArray<unknown>,
	TAccounts extends string,
> = [Exclude<DottedNeedsIn<TUse>, ProvidedBy<TUse>>] extends [never]
	? [string] extends [TAccounts]
		? ValidateRegisterCoinRefs<TUse>
		: [Exclude<SignsAsIn<TUse>, TAccounts>] extends [never]
			? ValidateRegisterCoinRefs<TUse>
			: `devstack: signer/runsAs/publisher '${Exclude<SignsAsIn<TUse>, TAccounts>}' is not a declared account name`
	: `devstack: needs '${Exclude<DottedNeedsIn<TUse>, ProvidedBy<TUse>>}' but no plugin in use:[] provides it`;

/**
 * Layered cross-check for `registerCoin` references: first the `from:`
 * literal is matched against every sibling `publishMove`'s name, then
 * the `package:` literal is matched against every sibling
 * `publishMove`'s `registryAs`. Returns `TUse` on success, branded
 * error string on the first failure.
 */
type ValidateRegisterCoinRefs<TUse extends ReadonlyArray<unknown>> = [
	Exclude<RegisterCoinFromIn<TUse>, PublishedPackagesIn<TUse>>,
] extends [never]
	? [Exclude<RegisterCoinPackagesIn<TUse>, PublishedRegistryAsIn<TUse>>] extends [never]
		? TUse
		: `devstack: registerCoin({package:'${Exclude<RegisterCoinPackagesIn<TUse>, PublishedRegistryAsIn<TUse>>}'}) names a registry key no sibling publishMove in use:[] declares`
	: `devstack: registerCoin({from:'${Exclude<RegisterCoinFromIn<TUse>, PublishedPackagesIn<TUse>>}'}) names a package no sibling publishMove in use:[] declares`;

/**
 * Normalize the input config: flatten the `use:` array, partition
 * `Plugin` instances from bare `Action`s, and fold the bare actions into
 * a synthetic `<app>-setup` plugin so cross-action `needs:` references
 * stay stable. The runtime consumes the returned `plugins:` field;
 * downstream consumers don't see the original `use:` shape.
 *
 * The generic `TUse` lets the type system infer the union of provided
 * action names — `defineDevstackConfig({...})` callers can extract it
 * via `ProvidedBy<typeof config.use>` for autocomplete or validation
 * helpers built atop the public surface.
 *
 * @example
 * ```ts
 * // devstack.config.ts
 * import {
 *   accounts,
 *   codegen,
 *   defineDevstackConfig,
 *   frontend,
 *   sui,
 *   walletApp,
 * } from '@mysten-incubation/devstack';
 *
 * export default defineDevstackConfig({
 *   app: 'hello',
 *   accounts: ['alice'],
 *   use: [sui(), accounts(), codegen(), walletApp(), frontend()],
 * });
 * ```
 */
export function defineDevstackConfig<
	const TUse extends ReadonlyArray<Plugin | Action | ReadonlyArray<Plugin | Action>>,
	const TAccountsField extends AccountsFieldShape = AccountsFieldShape,
>(input: {
	app: string;
	use: ValidateUse<TUse, AccountNames<TAccountsField>>;
	accounts?: TAccountsField;
	networks?: DevstackConfigInput['networks'];
}): DevstackConfig {
	// `input.use` is typed as `ValidateUse<TUse>` for compile-time
	// validation; at runtime it's always the user's `TUse` array
	// (validation failures surface as TS errors, not runtime ones).
	const useArray = input.use as unknown as ReadonlyArray<
		Plugin | Action | ReadonlyArray<Plugin | Action>
	>;
	const flat: Array<Plugin | Action> = [];
	for (const entry of useArray) {
		if (Array.isArray(entry)) {
			for (const inner of entry) flat.push(inner as Plugin | Action);
		} else {
			flat.push(entry as Plugin | Action);
		}
	}
	const plugins: Plugin[] = [];
	const setupActions: Action[] = [];
	for (const item of flat) {
		if (isPlugin(item)) {
			plugins.push(item);
		} else {
			setupActions.push(item);
		}
	}
	// Auto-injection: when the `accounts` plugin is in the use array, every
	// setup action that signs transactions (carries `runsAs`) implicitly
	// needs the account to be funded first. Inject `'accounts.fund'` into
	// such actions' `needs:` so app authors don't have to repeat it on
	// every publishMove/runTransaction/seed they declare.
	const hasAccountsPlugin = plugins.some((p) => p.name === 'accounts');
	if (hasAccountsPlugin) {
		for (let i = 0; i < setupActions.length; i++) {
			const action = setupActions[i];
			if (action === undefined) continue;
			if (action.runsAs === undefined) continue;
			const existing = action.needs ?? [];
			if (existing.includes('accounts.fund')) continue;
			setupActions[i] = { ...action, needs: ['accounts.fund', ...existing] } as Action;
		}
	}
	if (setupActions.length > 0) {
		const setupPluginName = `${input.app.replace(/[^a-z0-9_-]/gi, '-').toLowerCase()}-setup`;
		const setupPlugin: Plugin = {
			name: setupPluginName,
			description: `auto-synthesized from ${setupActions.length} inline use:[] action(s) (publishMove / seed / runTransaction / registerCoin)`,
			// Folded into the snapshot id: each setup action contributes its
			// name + needs + inputs. `runTransaction` build callbacks are
			// hashed via `Function.toString()` separately in the action's
			// own input hash — that catches inline edits but not closure-
			// captured constants (see notes/friction.md).
			inputs: setupActions.map((a) => ({
				name: a.name,
				type: a.type,
				needs: a.needs ?? null,
				inputs: a.inputs ?? null,
			})),
			actions: () => setupActions,
		};
		// Stamp the synthesizer brand so `expandPluginActions` lets this
		// `<app>-setup` plugin past the reserved-suffix check. Third-party
		// plugins reaching the same path without the brand are rejected.
		(setupPlugin as { [SYNTHESIZED]?: true })[SYNTHESIZED] = true;
		plugins.push(setupPlugin);
	}
	return {
		app: input.app,
		plugins,
		accounts: input.accounts,
		networks: input.networks,
	};
}

/** Type guard: a `Plugin` carries an `actions: () => Action[]` callable;
 * an `Action` doesn't. Both have a `name`, so we discriminate by the
 * presence of the `actions` function. */
function isPlugin(item: Plugin | Action): item is Plugin {
	return typeof (item as Plugin).actions === 'function';
}

export function expandPluginActions(plugins: Plugin[]): Action[] {
	const out: Action[] = [];
	for (const plugin of plugins) {
		validatePluginName(plugin.name);
		// Reserved-suffix gate: the lenient `validatePluginName` above accepts
		// `-setup` suffixes so the synthesized `<app>-setup` plugin from
		// `defineDevstackConfig` can pass through. A third party building a
		// `Plugin` literal directly (skipping `definePlugin`'s strict check)
		// could otherwise smuggle a colliding name in via this path. Reject
		// here unless the plugin carries the synthesizer brand.
		if (
			plugin.name.endsWith('-setup') &&
			(plugin as { [SYNTHESIZED]?: true })[SYNTHESIZED] !== true
		) {
			throw new Error(
				`expandPluginActions: plugin name '${plugin.name}' ends in '-setup' — ` +
					`that suffix is reserved for the synthetic plugin defineDevstackConfig ` +
					`builds from inline use:[] actions. Pick a different name.`,
			);
		}
		const raw = plugin.actions();

		// First pass — compute and validate each action's full name.
		// Bare names get auto-prefixed; dotted names must already match
		// the plugin's own namespace (a guard against a plugin trying to
		// forge actions in another plugin's namespace).
		const expanded: { action: Action; fullName: string }[] = [];
		const localFullNames = new Set<string>();
		for (const action of raw) {
			const fullName = expandActionName(action.name, plugin.name);
			if (localFullNames.has(fullName)) {
				throw new Error(
					`expandPluginActions: plugin '${plugin.name}' declared duplicate action '${fullName}'`,
				);
			}
			localFullNames.add(fullName);
			validateProvides(action.provides, plugin.name);
			expanded.push({ action, fullName });
		}

		// Optional cross-check: when the plugin sets `provides:` (a
		// runtime mirror of the `TProvides` type union), validate both
		// directions match the actions returned by `actions()`. Catches
		// typos like a declared `'sui.servic'` vs a returned `'sui.service'`
		// at config-load time. Plugins with dynamic action sets (template
		// literal types like `walrus.node-${number}`) leave `provides`
		// undefined and skip this check.
		if (plugin.provides !== undefined) {
			validateProvidesAgainstActions(plugin.name, plugin.provides, localFullNames);
		}

		// Second pass — resolve `needs`. Bare entries point at local
		// actions and must exist; dotted entries are cross-plugin FQNs;
		// `:before` queries are capability lookups handled by the topo
		// sorter. `plugin` is stamped here (overwriting any author-set
		// value) so the renderer's grouping/log-coloring is keyed off the
		// real owning plugin and can't be forged.
		for (const { action, fullName } of expanded) {
			const resolvedNeeds = (action.needs ?? []).map((n) =>
				resolveNeed(n, plugin.name, localFullNames),
			);
			out.push({
				...action,
				name: fullName,
				needs: resolvedNeeds,
				plugin: plugin.name,
			} as Action);
		}
	}
	return out;
}

/**
 * Lenient plugin-name validator. Used by `expandPluginActions` so
 * the synthetic `<app>-setup` plugin built by `defineDevstackConfig`
 * passes validation (it would fail the `-setup` reject below). Plugin
 * authors going through `definePlugin` get the strict
 * `validateUserPluginName` instead — they're rejected from the reserved
 * `-setup` suffix to keep collisions from surfacing as opaque
 * "duplicate action name" errors at topo time.
 */
function validatePluginName(name: string): void {
	if (!PLUGIN_NAME_RE.test(name)) {
		throw new Error(
			`definePlugin: invalid plugin name '${name}'. Must start with a lowercase ` +
				"letter and contain only lowercase letters, digits, '_' or '-'. No dots " +
				'— those are reserved as the plugin/action namespace separator.',
		);
	}
}

/**
 * Strict plugin-name validator used by `definePlugin`. Adds a
 * `-setup`-suffix reject on top of `validatePluginName` so a user-defined
 * plugin named `<x>-setup` doesn't collide with the synthetic
 * `<app>-setup` plugin that `defineDevstackConfig` builds from inline
 * `use:[]` actions. Without this guard, two plugins with the same name
 * surface as a vague duplicate-action-name error during topo
 * expansion — much harder to triage.
 */
function validateUserPluginName(name: string): void {
	validatePluginName(name);
	if (name.endsWith('-setup')) {
		throw new Error(
			`definePlugin: plugin name '${name}' ends in '-setup' — that suffix is reserved ` +
				`for the synthetic plugin defineDevstackConfig builds from inline use:[] actions. ` +
				`Pick a different name (e.g. '${name.replace(/-setup$/, '')}' or '${name.replace(/-setup$/, '-config')}').`,
		);
	}
}

// Action name suffixes (the part after `<plugin>.`). One segment of the
// same charset as plugin names — no dots, since dots are reserved as the
// plugin/action separator. Rejecting `arena.foo.bar` keeps `resolveNeed`
// honest: anything with a dot is a cross-plugin FQN, never a deeper
// nested local name.
const ACTION_SUFFIX_RE = /^[a-z][a-z0-9_-]*$/;

function expandActionName(actionName: string, pluginName: string): string {
	if (actionName.length === 0) {
		throw new Error(
			`expandPluginActions: plugin '${pluginName}' declared an action with an empty name`,
		);
	}
	if (!actionName.includes('.')) {
		if (!ACTION_SUFFIX_RE.test(actionName)) {
			throw new Error(
				`expandPluginActions: plugin '${pluginName}' declared action '${actionName}' ` +
					`whose suffix doesn't match ${ACTION_SUFFIX_RE} (lowercase letters, digits, ` +
					"'_' or '-'; must start with a letter).",
			);
		}
		return `${pluginName}.${actionName}`;
	}
	const ownPrefix = `${pluginName}.`;
	if (actionName.startsWith(ownPrefix)) {
		const suffix = actionName.slice(ownPrefix.length);
		if (!ACTION_SUFFIX_RE.test(suffix)) {
			throw new Error(
				`expandPluginActions: plugin '${pluginName}' declared action '${actionName}'. ` +
					`The suffix '${suffix}' must match ${ACTION_SUFFIX_RE} — multi-dot names ` +
					"like 'arena.foo.bar' aren't supported (dots are reserved as the " +
					'plugin/action separator).',
			);
		}
		return actionName;
	}
	throw new Error(
		`expandPluginActions: plugin '${pluginName}' declared action '${actionName}' ` +
			`with a dotted name outside its own namespace. Use the bare suffix and let ` +
			`the runtime auto-prefix (e.g. '${actionName.split('.').slice(1).join('.')}').`,
	);
}

/**
 * Cross-check the plugin's runtime `provides:` list against the actual
 * action FQNs it returns. Throws on either direction's mismatch with a
 * pointed message — the plugin author misspelled an entry in `provides:`
 * or forgot to update one side after renaming an action.
 */
function validateProvidesAgainstActions(
	pluginName: string,
	declared: readonly string[],
	localFullNames: Set<string>,
): void {
	const declaredSet = new Set(declared);
	for (const decl of declaredSet) {
		if (!localFullNames.has(decl)) {
			const candidates = Array.from(localFullNames).join(', ');
			throw new Error(
				`expandPluginActions: plugin '${pluginName}' declared provides include ` +
					`'${decl}' but no action with that name was returned. Returned actions: ` +
					`[${candidates}]. Likely a typo or stale provides entry.`,
			);
		}
	}
	for (const fq of localFullNames) {
		if (!declaredSet.has(fq)) {
			const declaredList = Array.from(declaredSet).join(', ');
			throw new Error(
				`expandPluginActions: plugin '${pluginName}' returned action '${fq}' but it ` +
					`isn't listed in the declared provides set [${declaredList}]. Add it to ` +
					`\`provides:\` or remove it from the actions list.`,
			);
		}
	}
}

/**
 * Throw when a plugin declares a capability that isn't namespaced under
 * its own name. Without the `<plugin>.` prefix, any other plugin can
 * declare `provides: ['<cap>']` and intercept the ordering — a real
 * issue in a multi-author plugin ecosystem.
 */
function validateProvides(
	provides: { capabilities?: string[] } | undefined,
	pluginName: string,
): void {
	const caps = provides?.capabilities ?? [];
	if (caps.length === 0) return;
	const expectedPrefix = `${pluginName}.`;
	for (const cap of caps) {
		if (!cap.startsWith(expectedPrefix)) {
			throw new Error(
				`devstack: plugin '${pluginName}' declared capability '${cap}' without its own ` +
					`namespace prefix. Rename to '${expectedPrefix}${cap}' (and update any ` +
					`':before' queries to match).`,
			);
		}
	}
}

function resolveNeed(need: string, pluginName: string, localFullNames: Set<string>): string {
	// Capability queries are passed through verbatim — topo resolves them.
	if (need.endsWith(':before')) return need;
	// Already-qualified cross-plugin references pass through.
	if (need.includes('.')) return need;
	// Bare name → must reference a local action.
	const localFq = `${pluginName}.${need}`;
	if (!localFullNames.has(localFq)) {
		throw new Error(
			`expandPluginActions: plugin '${pluginName}' has bare need '${need}' but no ` +
				`local action with that name. For a cross-plugin reference, use the ` +
				`fully-qualified form '<plugin>.${need}'. For a capability query, use ` +
				`'${need}:before'.`,
		);
	}
	return localFq;
}
