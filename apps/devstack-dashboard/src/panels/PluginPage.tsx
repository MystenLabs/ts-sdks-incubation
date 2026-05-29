// Plugin-page dispatcher. Routes `#/plugin/<key>` to a per-plugin view from the
// `PLUGIN_VIEWS` registry; unknown keys fall back to a generic stub. Each view
// receives `PluginViewProps` — the shared `PanelProps` plus the resolved
// `pluginKey` and the matching projection `row` (or null). Round-3 panel agents
// own the individual view files in `panels/plugins/*` and never touch this file.

import type { ComponentType, ReactNode } from 'react';
import { Icon, type IconName, StatusBadge, EmptyState } from '../ui/index.ts';
import { humanize } from '../lib/format.ts';
import { PLUGINS } from '../shell/nav.ts';
import type { Row } from '../lib/types.ts';
import type { PanelProps } from './types.ts';

import { DeepBookView } from './plugins/DeepBook.tsx';
import { WalrusView } from './plugins/Walrus.tsx';
import { SealView } from './plugins/Seal.tsx';
import { CoinsView } from './plugins/Coins.tsx';
import { PostgresView } from './plugins/Postgres.tsx';

/**
 * Props every per-plugin view receives. It is `PanelProps` (projection, chain
 * source, endpoint, activity, …) plus the resolved plugin key and the projection
 * row that backs this plugin's status (or null when none matches).
 */
export interface PluginViewProps extends PanelProps {
	/** The plugin key this page renders (`deepbook`, `walrus`, …). */
	readonly pluginKey: string;
	/** Projection row backing this plugin's status badge, or null. */
	readonly row: Row | null;
}

/** Per-plugin view registry, keyed by plugin key. */
export const PLUGIN_VIEWS: Record<string, ComponentType<PluginViewProps>> = {
	deepbook: DeepBookView,
	walrus: WalrusView,
	seal: SealView,
	coins: CoinsView,
	postgres: PostgresView,
};

const META = new Map(PLUGINS.map((p) => [p.key, p]));

/** Resolve title + icon for a plugin key, falling back to a humanized key. */
const metaFor = (key: string): { label: string; icon: IconName } => {
	const known = META.get(key);
	return known ? { label: known.label, icon: known.icon } : { label: humanize(key), icon: 'plug' };
};

/**
 * Find the projection row backing a plugin page. Matches the row whose `key` is
 * exactly the plugin key, or is namespaced beneath it (`<key>:…`, `<key>-…`,
 * `<key>.…`). The previous `key.includes(key)` substring match was fragile —
 * e.g. `seal` would have matched an unrelated `unseal`/`reseal` row.
 */
export const rowForPlugin = (rows: ReadonlyArray<Row>, key: string): Row | null => {
	const exact = rows.find((r) => r.key === key);
	if (exact) return exact;
	return rows.find((r) => /^[:.\-]/.test(r.key.slice(key.length)) && r.key.startsWith(key)) ?? null;
};

/** Generic fallback for plugin keys without a registered view. */
const GenericPluginView = ({ pluginKey, row }: PluginViewProps) => {
	const { label, icon } = metaFor(pluginKey);
	return (
		<PluginScaffold label={label} icon={icon} row={row}>
			<div className="panel">
				<EmptyState
					icon={icon}
					title={`${label} panel coming soon`}
					hint="This plugin's domain view hasn't been wired to the dashboard yet."
				/>
			</div>
		</PluginScaffold>
	);
};

/**
 * Shared header chrome for plugin views: icon tile + title + status badge from
 * the projection row. Per-plugin views compose their body as `children`.
 */
export const PluginScaffold = ({
	label,
	icon,
	row,
	subtitle,
	children,
}: {
	readonly label: string;
	readonly icon: IconName;
	readonly row: Row | null;
	readonly subtitle?: string;
	readonly children?: ReactNode;
}) => (
	<div className="col" style={{ gap: 18 }}>
		<div className="row between wrap" style={{ gap: 12 }}>
			<div className="row" style={{ gap: 12 }}>
				<div
					style={{
						width: 40,
						height: 40,
						borderRadius: 11,
						display: 'grid',
						placeItems: 'center',
						background: 'color-mix(in oklab, var(--accent) 14%, transparent)',
						color: 'var(--accent)',
						flex: 'none',
					}}
				>
					<Icon name={icon} size={20} />
				</div>
				<div>
					<div className="row" style={{ gap: 9 }}>
						<h2 style={{ fontSize: 19 }}>{label}</h2>
						{row && <StatusBadge status={row.status} />}
					</div>
					<p style={{ color: 'var(--tx-mid)', fontSize: 13, margin: '3px 0 0' }}>
						{subtitle ?? 'Plugin control surface.'}
					</p>
				</div>
			</div>
		</div>
		{children}
	</div>
);

/** Dispatch `#/plugin/<key>` to its registered view (or the generic fallback). */
export const PluginPanel = (props: PanelProps & { pluginKey: string }) => {
	const { pluginKey } = props;
	const row = rowForPlugin(props.projection.rows, pluginKey);
	const View = PLUGIN_VIEWS[pluginKey] ?? GenericPluginView;
	return <View {...props} row={row} />;
};
