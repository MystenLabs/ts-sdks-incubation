// `definePlugin()` — identity helper for typed plugin authoring.
//
// `expandPluginActions(plugins)` runs each plugin's actions callback,
// auto-prefixes bare action names with the plugin's namespace
// (`<plugin>.<name>`), and resolves bare-name `needs:` entries to the
// same local-prefixed form. Cross-plugin references stay fully
// qualified; capability queries (`<cap>:before`) are passed through to
// the topo sorter unchanged.

import type {
	Action,
	DevstackConfig,
	DevstackConfigInput,
	Plugin,
	Provides,
} from './core/types.js';

const PLUGIN_NAME_RE = /^[a-z][a-z0-9_-]*$/;

export function definePlugin<TProvides extends string = string>(
	plugin: Plugin<TProvides>,
): Plugin<TProvides> {
	validatePluginName(plugin.name);
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
 */
type DottedNeedsIn<TUse extends ReadonlyArray<unknown>> = TUse[number] extends infer Entry
	? Entry extends ReadonlyArray<unknown>
		? DottedNeedsIn<Entry>
		: Entry extends { __needs?: infer N }
			? N extends `${string}.${string}`
				? N
				: never
			: never
	: never;

/**
 * Validation: returns `TUse` if every dotted `needs:` reference matches
 * a `Plugin<TProvides>` provides string in the same array; otherwise
 * returns a branded error string that surfaces as a `Type 'X' is not
 * assignable to type 'Error: ...'` message at the call site.
 */
type ValidateUse<TUse extends ReadonlyArray<unknown>> = [
	Exclude<DottedNeedsIn<TUse>, ProvidedBy<TUse>>,
] extends [never]
	? TUse
	: `devstack: needs '${Exclude<DottedNeedsIn<TUse>, ProvidedBy<TUse>>}' but no plugin in use:[] provides it`;

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
 */
export function defineDevstackConfig<
	const TUse extends ReadonlyArray<Plugin | Action | ReadonlyArray<Plugin | Action>>,
>(input: {
	app: string;
	use: ValidateUse<TUse>;
	accounts?: DevstackConfigInput['accounts'];
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

function validatePluginName(name: string): void {
	if (!PLUGIN_NAME_RE.test(name)) {
		throw new Error(
			`definePlugin: invalid plugin name '${name}'. Must start with a lowercase ` +
				"letter and contain only lowercase letters, digits, '_' or '-'. No dots " +
				'— those are reserved as the plugin/action namespace separator.',
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
 * Throw when a plugin declares a capability that isn't namespaced under
 * its own name. Without the `<plugin>.` prefix, any other plugin can
 * declare `provides: ['<cap>']` and intercept the ordering — a real
 * issue in a multi-author plugin ecosystem.
 */
function validateProvides(provides: Provides | undefined, pluginName: string): void {
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
