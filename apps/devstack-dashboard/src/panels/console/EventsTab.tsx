// Events tab — the client-derived activity feed (successive-projection diff,
// newest-first). Each row: relative time, a colored scope rail + dot, a mono
// tag (the diff `kind`), the curated message (or the raw `{plugin, scope}`
// shape under the Raw toggle), and a plugin badge. Clicking a row routes to
// Services filtered to that plugin — the same `navigate('services', key)` the
// other panels use. The Scope filter facets on the activity `section`.

import { useMemo, useState } from 'react';
import type { ActivityItem } from '../../lib/useProjection.ts';
import type { RowSection } from '../../lib/types.ts';
import { labelForRow, sectionLabel, sectionToken } from '../../lib/derive.ts';
import { timeAgo } from '../../lib/format.ts';
import { navigate } from '../../lib/router.ts';
import { Badge, Dot, EmptyState, MultiSelect, type MultiSelectOption } from '../../ui/index.ts';

// Scopes correspond to the activity item's `section`. `other` is rendered with
// the neutral `white` token (matching the prior Console behavior).
const SCOPE_SECTIONS: ReadonlyArray<RowSection> = [
	'service',
	'package',
	'account',
	'action',
	'app',
	'other',
];
const SCOPE_OPTIONS: ReadonlyArray<MultiSelectOption> = SCOPE_SECTIONS.map((s) => ({
	value: s,
	label: s === 'other' ? 'other' : sectionLabel(s).toLowerCase(),
	token: s === 'other' ? 'white' : sectionToken(s),
}));

export const EventsTab = ({
	activity,
}: {
	readonly activity: ReadonlyArray<ActivityItem>;
}) => {
	const [scopes, setScopes] = useState<ReadonlyArray<string>>([]);
	const [raw, setRaw] = useState(false);

	const toggleScope = (value: string) =>
		setScopes((cur) => (cur.includes(value) ? cur.filter((v) => v !== value) : [...cur, value]));

	const filtered = useMemo(
		() => (scopes.length === 0 ? activity : activity.filter((e) => scopes.includes(e.section))),
		[activity, scopes],
	);

	return (
		<div className="col" style={{ gap: 12, height: '100%' }}>
			<div className="row wrap" style={{ gap: 9 }}>
				<MultiSelect
					label="Scope"
					icon="filter"
					options={SCOPE_OPTIONS}
					selected={scopes}
					onToggle={toggleScope}
				/>
				<div className="grow" />
				<button
					className="btn btn-sm"
					onClick={() => setRaw((r) => !r)}
					style={raw ? { borderColor: 'var(--accent-line)', color: 'var(--accent)' } : undefined}
				>
					{raw ? 'Raw tags' : 'Curated'}
				</button>
			</div>

			{filtered.length === 0 ? (
				<div className="panel grow" style={{ display: 'grid', placeItems: 'center' }}>
					<EmptyState
						icon="activity"
						title={activity.length === 0 ? 'No activity yet' : 'No events in scope'}
						hint={
							activity.length === 0
								? 'Status changes, endpoints, and errors appear here as the projection updates.'
								: 'Adjust the scope filter to surface more events.'
						}
					/>
				</div>
			) : (
				<div className="panel scroll-y grow" style={{ padding: '6px 4px' }}>
					{filtered.map((item) => {
						const token = item.section === 'other' ? 'white' : sectionToken(item.section);
						const clickable = item.pluginKey !== null;
						const plugin = item.pluginKey;
						return (
							<div
								key={item.id}
								className="row fade-up"
								onClick={clickable ? () => navigate('services', plugin ?? undefined) : undefined}
								style={{
									gap: 9,
									padding: '6px 10px',
									borderRadius: 7,
									cursor: clickable ? 'pointer' : 'default',
								}}
								onMouseEnter={
									clickable
										? (e) => {
												e.currentTarget.style.background = 'var(--bg-hover)';
											}
										: undefined
								}
								onMouseLeave={
									clickable
										? (e) => {
												e.currentTarget.style.background = 'transparent';
											}
										: undefined
								}
							>
								<span
									className="mono"
									style={{ fontSize: 11, color: 'var(--tx-dim)', minWidth: 44 }}
								>
									{timeAgo(item.at)}
								</span>
								<span
									style={{
										width: 3,
										alignSelf: 'stretch',
										borderRadius: 3,
										background: `var(--c-${token})`,
										margin: '2px 0',
									}}
								/>
								<Dot token={token} />
								<span
									className="mono"
									style={{ fontSize: 11.5, color: `var(--c-${token})`, minWidth: 64 }}
								>
									{item.kind}
								</span>
								{raw ? (
									<span
										className="mono trunc grow"
										style={{ fontSize: 11.5, color: 'var(--tx-mid)' }}
									>
										{`{ plugin: ${JSON.stringify(plugin)}, scope: ${JSON.stringify(item.section)} }`}
									</span>
								) : (
									<span className="trunc grow" style={{ fontSize: 12.5, color: 'var(--tx-mid)' }}>
										{item.text}
									</span>
								)}
								{plugin && (
									<Badge style={{ height: 18, fontSize: 10 }}>{labelForRow(plugin)}</Badge>
								)}
							</div>
						);
					})}
				</div>
			)}
		</div>
	);
};
