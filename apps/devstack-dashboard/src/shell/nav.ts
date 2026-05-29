// Static nav model for the rail + command palette. Mirrors the README IA and
// the design handoff's `NAV`/`PLUGIN_NAV` arrays. Plugin items route to
// `plugin:<key>`; everything else is a bare route name.

import type { IconName } from '../ui/index.ts';

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
	{ key: 'postgres', label: 'Postgres', icon: 'database' },
];

const PLUGIN_NAV: ReadonlyArray<NavItem> = PLUGINS.map((p) => ({
	id: `plugin:${p.key}`,
	label: p.label,
	icon: p.icon,
	pluginKey: p.key,
}));

/** Nav rail structure, grouped exactly per the README / app.jsx. */
export const NAV_SECTIONS: ReadonlyArray<NavSection> = [
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
	{ label: 'Plugins', items: PLUGIN_NAV },
	{
		label: 'Manage',
		items: [
			{ id: 'controls', label: 'Controls', icon: 'sliders' },
			{ id: 'config', label: 'Config', icon: 'cog' },
		],
	},
];

/** Flattened nav items (no section eyebrows), for palette navigation. */
export const NAV_ITEMS: ReadonlyArray<NavItem> = NAV_SECTIONS.flatMap((s) => s.items);
