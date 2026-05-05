// Group every entry in a `SerializedRegistry` snapshot by the action
// that registered it (`providedBy`). Both renderers use this to drive
// per-row output lines in the status table — the supervisor doesn't
// have to maintain a parallel "endpoints" map.
//
// Each output collapses a registry item into a `(label, value)` pair:
//
//   - Service: label = short kind (`sui-rpc` → `rpc`,
//     `walrus-aggregator` → `aggregator`); value = url. Plugin
//     prefixes are stripped so the row reads as `rpc http://…` rather
//     than `sui-rpc http://…`.
//   - Package: label = `package`; value = `<name> <packageId>` so the
//     row shows which package this action published.
//   - Account: label = `account`; value = `<name> <address>` for the
//     `accounts.fund` action's outputs.
//   - Plugin namespace kinds (walrus.nodes, seal.keys, …): rendered
//     generically as `<kind> <count>` so plugin authors don't need to
//     teach the renderer their shape.
//
// Items without `providedBy` (legacy or directly-injected entries)
// are skipped — there's no row to attach them to.

import type { SerializedRegistry } from '../manifest-types.js';

export interface RegistryOutput {
	label: string;
	value: string;
}

interface NamedItem {
	name?: string;
	providedBy?: string;
}

interface ServiceItem extends NamedItem {
	kind?: string;
	url?: string;
}

interface PackageItem extends NamedItem {
	packageId?: string;
}

interface AccountItem extends NamedItem {
	address?: string;
}

const BUILTIN_KINDS = new Set(['packages', 'accounts', 'services']);

export function groupRegistryByProvider(
	reg: SerializedRegistry,
): Map<string, RegistryOutput[]> {
	const map = new Map<string, RegistryOutput[]>();
	const push = (provider: string, output: RegistryOutput): void => {
		const list = map.get(provider) ?? [];
		list.push(output);
		map.set(provider, list);
	};

	for (const svc of reg.services as ServiceItem[]) {
		if (svc.providedBy === undefined) continue;
		push(svc.providedBy, {
			label: shortServiceLabel(svc),
			value: svc.url ?? '',
		});
	}
	for (const pkg of reg.packages as PackageItem[]) {
		if (pkg.providedBy === undefined || pkg.packageId === undefined) continue;
		// Full packageId — truncating it ("0xab12…cdef") looks tidy but
		// makes the row unusable: copy-pasting a truncated ID into a
		// `sui client` command, MVR override, or a bug report fails.
		push(pkg.providedBy, {
			label: 'package',
			value: `${pkg.name ?? ''} ${pkg.packageId}`.trim(),
		});
	}
	for (const acc of reg.accounts as AccountItem[]) {
		if (acc.providedBy === undefined || acc.address === undefined) continue;
		push(acc.providedBy, {
			label: 'account',
			value: `${acc.name ?? ''} ${acc.address}`.trim(),
		});
	}
	// Plugin-namespaced kinds (`walrus.nodes`, `seal.keys`, …). We
	// render a generic `<plugin>.<kind> <count>` line attributed to the
	// FIRST item's `providedBy` per kind — same action typically owns
	// all items of a given namespaced kind in this codebase, and the
	// alternative (one row per item) explodes when a plugin registers
	// dozens of nodes. Items without `providedBy` are skipped.
	for (const [namespace, value] of Object.entries(reg)) {
		if (BUILTIN_KINDS.has(namespace)) continue;
		const bag = value as Record<string, NamedItem[]>;
		if (typeof bag !== 'object' || bag === null) continue;
		for (const [kind, items] of Object.entries(bag)) {
			if (!Array.isArray(items) || items.length === 0) continue;
			const owners = new Map<string, number>();
			for (const item of items) {
				const owner = item.providedBy;
				if (owner === undefined) continue;
				owners.set(owner, (owners.get(owner) ?? 0) + 1);
			}
			for (const [owner, count] of owners) {
				push(owner, { label: `${namespace}.${kind}`, value: String(count) });
			}
		}
	}

	return map;
}

function shortServiceLabel(svc: ServiceItem): string {
	const k = svc.kind ?? svc.name ?? '';
	// Strip `<plugin>-` prefix if present (`sui-rpc` → `rpc`,
	// `walrus-aggregator` → `aggregator`).
	const dash = k.indexOf('-');
	if (dash > 0) return k.slice(dash + 1);
	return k;
}

