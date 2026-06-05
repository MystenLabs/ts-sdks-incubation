// Plugin-page dispatcher. Routes `#/plugin/<key>` to a per-plugin view from the
// `PLUGIN_VIEWS` registry; unknown keys fall back to a generic stub. Each view
// receives `PluginViewProps` — the shared `PanelProps` plus the resolved
// `pluginKey` and the matching projection `row` (or null). Round-3 panel agents
// own the individual view files in `panels/plugins/*` and never touch this file.

import type { ComponentType, ReactNode } from 'react';
import { Icon, type IconName, StatusBadge, EmptyState } from '../ui/index.ts';
import { humanize } from '../lib/format.ts';
import { rowForPlugin } from '../lib/derive.ts';
import { PLUGINS } from '../shell/nav.ts';
import type { Row } from '../lib/types.ts';
import type { PanelProps } from './types.ts';

import { DeepBookView } from './plugins/DeepBook.tsx';
import { WalrusView } from './plugins/Walrus.tsx';
import { SealView } from './plugins/Seal.tsx';
import { CoinsView } from './plugins/Coins.tsx';

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
};

const META = new Map(PLUGINS.map((p) => [p.key, p]));

/** Resolve title + icon for a plugin key, falling back to a humanized key. */
const metaFor = (key: string): { label: string; icon: IconName } => {
	const known = META.get(key);
	return known ? { label: known.label, icon: known.icon } : { label: humanize(key), icon: 'plug' };
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
 * Explicit "not in this stack" state. The nav lists every known plugin, so a
 * plugin route can be selected for a plugin the running stack doesn't include
 * (no managed projection row). Rather than silently bounce to Overview, render
 * an honest empty state telling the user how to add it.
 */
const NotInStackView = ({ pluginKey }: { pluginKey: string }) => {
	const { label, icon } = metaFor(pluginKey);
	return (
		<PluginScaffold label={label} icon={icon} row={null} subtitle="Not part of this stack.">
			<div className="panel">
				<EmptyState
					icon={icon}
					title={`${label} isn't part of this stack`}
					hint={`Add \`${pluginKey}()\` to your devstack config to see this panel.`}
				/>
			</div>
		</PluginScaffold>
	);
};

/**
 * Shared header chrome for plugin views, matching the design's plugin header bar:
 * a token-tinted icon tile + title + status badge, a `tag · phase` line (mono
 * phase), and an optional right-aligned `actions` slot (e.g. Restart / Logs &
 * events). Per-plugin views compose their body as `children`.
 *
 * `token` is a design color token (`blue`, `cyan`, …) used to tint the tile;
 * absent → the neutral `accent`. `subtitle` is the design's `tag`; `phase` is
 * the mono suffix (falls back to the projection row's phase, then the label).
 */
export const PluginScaffold = ({
	label,
	icon,
	row,
	subtitle,
	token,
	phase,
	actions,
	children,
}: {
	readonly label: string;
	readonly icon: IconName;
	readonly row: Row | null;
	readonly subtitle?: string;
	/** Design color token tinting the icon tile (`blue`, `cyan`, …). */
	readonly token?: string;
	/** Mono phase suffix on the tag line; defaults to the row's phase. */
	readonly phase?: string;
	/** Right-aligned header actions (Restart, Logs & events, …). */
	readonly actions?: ReactNode;
	readonly children?: ReactNode;
}) => {
	const accent = token ? `var(--c-${token})` : 'var(--accent)';
	const phaseLabel = phase ?? row?.phase ?? label;
	return (
		<div className="col" style={{ gap: 18 }}>
			<div className="row between wrap" style={{ gap: 12 }}>
				<div className="row" style={{ gap: 13 }}>
					<div
						style={{
							width: 42,
							height: 42,
							borderRadius: 11,
							display: 'grid',
							placeItems: 'center',
							background: `color-mix(in oklab, ${accent} 16%, transparent)`,
							color: accent,
							flex: 'none',
							boxShadow: `0 0 0 1px color-mix(in oklab, ${accent} 28%, transparent)`,
						}}
					>
						<Icon name={icon} size={21} />
					</div>
					<div>
						<div className="row" style={{ gap: 10 }}>
							<h2 style={{ fontSize: 19 }}>{label}</h2>
							{row && <StatusBadge status={row.status} />}
						</div>
						<span style={{ fontSize: 12.5, color: 'var(--tx-mid)' }}>
							{subtitle ?? 'Plugin control surface.'} ·{' '}
							<span className="mono" style={{ color: 'var(--tx-lo)' }}>
								{phaseLabel}
							</span>
						</span>
					</div>
				</div>
				{actions && (
					<div className="row" style={{ gap: 8 }}>
						{actions}
					</div>
				)}
			</div>
			{children}
		</div>
	);
};

/** Dispatch `#/plugin/<key>` to its registered view (or the generic fallback). */
export const PluginPanel = (props: PanelProps & { pluginKey: string }) => {
	const { pluginKey } = props;
	const row = rowForPlugin(props.projection.rows, pluginKey);
	// The nav lists every known plugin, but only plugins actually in the running
	// stack have a managed projection row. When the selected plugin has none,
	// render an explicit "not in this stack" state instead of its (data-less)
	// panel — honest over a silent redirect.
	if (row === null) return <NotInStackView pluginKey={pluginKey} />;
	const View = PLUGIN_VIEWS[pluginKey] ?? GenericPluginView;
	return <View {...props} row={row} />;
};
