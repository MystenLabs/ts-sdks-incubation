// Generic plugin page — an honest stub. Header bar (icon tile + title +
// StatusBadge derived from the matching row, when present), then an EmptyState.
// No domain data is fabricated; per-plugin bodies land later.

import { Icon, type IconName, StatusBadge, EmptyState } from '../ui/index.ts';
import { humanize } from '../lib/format.ts';
import { PLUGINS } from '../shell/nav.ts';
import type { PanelProps } from './types.ts';

const META = new Map(PLUGINS.map((p) => [p.key, p]));

/** Resolve title + icon for a plugin key, falling back to a humanized key. */
const metaFor = (key: string): { label: string; icon: IconName } => {
	const known = META.get(key);
	return known ? { label: known.label, icon: known.icon } : { label: humanize(key), icon: 'plug' };
};

/** Find the projection row a plugin page should reflect (status badge). */
const rowForPlugin = (props: PanelProps, key: string) =>
	props.projection.rows.find((r) => r.key === key || r.key.includes(key)) ?? null;

export const PluginPanel = (props: PanelProps & { pluginKey: string }) => {
	const { pluginKey } = props;
	const { label, icon } = metaFor(pluginKey);
	const row = rowForPlugin(props, pluginKey);

	return (
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
							Plugin control surface.
						</p>
					</div>
				</div>
			</div>

			<div className="panel">
				<EmptyState
					icon={icon}
					title={`${label} panel coming soon`}
					hint="This plugin's domain view hasn't been wired to the dashboard yet."
				/>
			</div>
		</div>
	);
};
