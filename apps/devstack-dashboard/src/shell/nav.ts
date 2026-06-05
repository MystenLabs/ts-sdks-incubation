// Nav model for the rail + command palette. Mirrors the README IA and the
// design handoff's `NAV`/`PLUGIN_NAV` arrays. Plugin items route to
// `plugin:<key>`; everything else is a bare route name.
//
// The fixed sections (Overview/Chain/Manage) are static; the Plugins section is
// derived from the live projection — only plugins actually present in the
// running stack get a nav item, and the section header is hidden when none are.

import type { IconName } from '../ui/index.ts';
import { presentPlugins } from '../lib/derive.ts';
import type { Row } from '../lib/types.ts';

export interface NavItem {
	readonly id: string;
	readonly label: string;
	readonly icon: IconName;
	/** Plugin key for `plugin:<key>` items; absent for plain routes. */
	readonly pluginKey?: string;
}

export interface NavSection {
	/** Section eyebrow, or null for the top (unlabelled) group. */
	readonly label: string | null;
	readonly items: ReadonlyArray<NavItem>;
}

/** Plugin pages, in display order. Routes are `plugin:<key>`. */
export const PLUGINS: ReadonlyArray<{ key: string; label: string; icon: IconName }> = [
	{ key: 'deepbook', label: 'DeepBook', icon: 'layers' },
	{ key: 'walrus', label: 'Walrus', icon: 'database' },
	{ key: 'seal', label: 'Seal', icon: 'plug' },
	{ key: 'coins', label: 'Coins', icon: 'coins' },
];

/** A nav item for a single plugin key, using its registry label + icon. */
const pluginNavItem = (key: string): NavItem => {
	const meta = PLUGINS.find((p) => p.key === key);
	return {
		id: `plugin:${key}`,
		label: meta?.label ?? key,
		icon: meta?.icon ?? 'plug',
		pluginKey: key,
	};
};

/** The fixed (projection-independent) nav sections, in display order. */
const STATIC_SECTIONS: ReadonlyArray<NavSection> = [
	{
		label: null,
		items: [
			{ id: 'overview', label: 'Overview', icon: 'grid' },
			{ id: 'services', label: 'Services', icon: 'layers' },
			{ id: 'activity', label: 'Console', icon: 'terminal' },
		],
	},
	{
		label: 'Chain',
		items: [
			{ id: 'accounts', label: 'Accounts', icon: 'wallet' },
			{ id: 'faucet', label: 'Faucet', icon: 'drop' },
			{ id: 'explorer', label: 'Explorer', icon: 'compass' },
		],
	},
];

const MANAGE_SECTION: NavSection = {
	label: 'Manage',
	items: [
		{ id: 'controls', label: 'Controls', icon: 'sliders' },
		{ id: 'config', label: 'Config', icon: 'cog' },
	],
};

/**
 * Build the nav rail structure for the running stack. The Plugins section is
 * derived from the projection: it lists only plugins with a managed row, and is
 * omitted entirely when the stack includes none (e.g. sui + accounts only).
 */
export const buildNav = (rows: ReadonlyArray<Row>): ReadonlyArray<NavSection> => {
	const pluginKeys = presentPlugins(
		rows,
		PLUGINS.map((p) => p.key),
	);
	const pluginSection: ReadonlyArray<NavSection> =
		pluginKeys.length > 0 ? [{ label: 'Plugins', items: pluginKeys.map(pluginNavItem) }] : [];
	return [...STATIC_SECTIONS, ...pluginSection, MANAGE_SECTION];
};

/** Flattened nav items (no section eyebrows), for palette navigation. */
export const navItems = (sections: ReadonlyArray<NavSection>): ReadonlyArray<NavItem> =>
	sections.flatMap((s) => s.items);
