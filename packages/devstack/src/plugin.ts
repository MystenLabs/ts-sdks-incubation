// `definePlugin()` — identity helper for typed plugin authoring.
//
// `expandPluginActions(plugins)` runs each plugin's actions callback,
// auto-prefixes bare action names with the plugin's namespace
// (`<plugin>.<name>`), and resolves bare-name `needs:` entries to the
// same local-prefixed form. Cross-plugin references stay fully
// qualified; capability queries (`<cap>:before`) are passed through to
// the topo sorter unchanged.

import type { Action, DevstackConfig, Plugin, Provides } from './core/types.js';
import { getProvidedCapabilities } from './core/types.js';

const PLUGIN_NAME_RE = /^[a-z][a-z0-9_-]*$/;

export function definePlugin(plugin: Plugin): Plugin {
	validatePluginName(plugin.name);
	return plugin;
}

/**
 * Identity helper for `devstack.config.ts`. Apps invoke this to declare
 * their config so editors infer types from the locked thin shape
 * (§8.3): `{ app, plugins, networks?, test? }`. Pure passthrough — the
 * loader inspects the value at runtime.
 */
export function defineDevstackConfig(config: DevstackConfig): DevstackConfig {
	return config;
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
		// sorter.
		for (const { action, fullName } of expanded) {
			const resolvedNeeds = (action.needs ?? []).map((n) =>
				resolveNeed(n, plugin.name, localFullNames),
			);
			out.push({ ...action, name: fullName, needs: resolvedNeeds } as Action);
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

function expandActionName(actionName: string, pluginName: string): string {
	if (actionName.length === 0) {
		throw new Error(
			`expandPluginActions: plugin '${pluginName}' declared an action with an empty name`,
		);
	}
	if (!actionName.includes('.')) return `${pluginName}.${actionName}`;
	const ownPrefix = `${pluginName}.`;
	if (actionName.startsWith(ownPrefix)) return actionName;
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
	const caps = getProvidedCapabilities(provides);
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
