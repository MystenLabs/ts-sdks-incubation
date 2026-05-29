// Console panel — three views over live observability surfaces:
//
//   • Logs    — aggregated `logTail` ring buffers across every projection row.
//   • Events  — the client-derived `activity` feed (projection diff, newest-first).
//   • Traces  — honest stub; the SpanStore tracer is not wired yet.
//
// All data is consumed from `PanelProps` (projection + activity). Nothing is
// fabricated: there is no live log stream, so Logs renders the current static
// tail with a muted "tail" note rather than pretending to follow.

import { type ChangeEvent, useMemo, useState } from 'react';
import type { PanelProps } from './types.ts';
import type { LogLevel } from '../lib/types.ts';
import { labelForRow, sectionToken } from '../lib/derive.ts';
import { timeAgo } from '../lib/format.ts';
import { navigate } from '../lib/router.ts';
import {
	Badge,
	Dot,
	EmptyState,
	Icon,
	LevelPill,
	type MultiSelectOption,
	MultiSelect,
	Segmented,
} from '../ui/index.ts';

type ConsoleTab = 'logs' | 'events' | 'traces';

const TABS = [
	{ value: 'logs' as const, label: 'Logs' },
	{ value: 'events' as const, label: 'Events' },
	{ value: 'traces' as const, label: 'Traces' },
];

// Each level carries a semantic dot token so the dropdown surfaces its color.
const LEVEL_OPTIONS: ReadonlyArray<MultiSelectOption> = [
	{ value: 'info', label: 'info', token: 'cyan' },
	{ value: 'warn', label: 'warn', token: 'yellow' },
	{ value: 'error', label: 'error', token: 'red' },
];

export const ConsolePanel = ({ projection, activity }: PanelProps) => {
	const [tab, setTab] = useState<ConsoleTab>('logs');

	return (
		<div className="col" style={{ gap: 16, height: '100%' }}>
			<div className="row between wrap" style={{ gap: 12 }}>
				<div>
					<h2 style={{ fontSize: 19 }}>Console</h2>
					<p style={{ color: 'var(--tx-mid)', fontSize: 13, margin: '3px 0 0' }}>
						Live logs, the engine event stream, and span traces — one place.
					</p>
				</div>
				<Segmented options={TABS} value={tab} onChange={setTab} />
			</div>
			<div className="grow" style={{ minHeight: 0 }}>
				{tab === 'logs' ? (
					<LogsView projection={projection} />
				) : tab === 'events' ? (
					<EventsView activity={activity} />
				) : (
					<TracesView />
				)}
			</div>
		</div>
	);
};

// --- Logs -------------------------------------------------------------------

interface LogEntry {
	readonly id: string;
	readonly tag: string;
	readonly level: LogLevel;
	readonly text: string;
}

const LOG_LEVEL_COLOR: Record<LogLevel, string> = {
	error: 'var(--c-red)',
	warn: 'var(--c-yellow)',
	info: 'var(--tx-hi)',
};

const LogsView = ({ projection }: Pick<PanelProps, 'projection'>) => {
	const [query, setQuery] = useState('');
	const [plugins, setPlugins] = useState<ReadonlyArray<string>>([]);
	const [levels, setLevels] = useState<ReadonlyArray<string>>([]);

	const togglePlugin = (value: string) =>
		setPlugins((cur) => (cur.includes(value) ? cur.filter((v) => v !== value) : [...cur, value]));
	const toggleLevel = (value: string) =>
		setLevels((cur) => (cur.includes(value) ? cur.filter((v) => v !== value) : [...cur, value]));

	// Distinct row labels for the plugin filter, in projection order.
	const pluginOptions = useMemo(() => {
		const seen = new Set<string>();
		const labels: string[] = [];
		for (const row of projection.rows) {
			const label = labelForRow(row.key);
			if (!seen.has(label)) {
				seen.add(label);
				labels.push(label);
			}
		}
		return labels;
	}, [projection.rows]);

	// Flatten each row's log tail into per-line entries, tagged with its label.
	const { entries, truncated } = useMemo(() => {
		const all: LogEntry[] = [];
		let anyTruncated = false;
		for (const row of projection.rows) {
			const { lines, level: rowLevel, truncated: rowTruncated } = row.logTail;
			if (rowTruncated) anyTruncated = true;
			lines.forEach((text, i) => {
				all.push({
					id: `${row.key}#${i}`,
					tag: labelForRow(row.key),
					level: rowLevel,
					text,
				});
			});
		}
		return { entries: all, truncated: anyTruncated };
	}, [projection.rows]);

	const filtered = useMemo(() => {
		const needle = query.trim().toLowerCase();
		return entries.filter(
			(e) =>
				(plugins.length === 0 || plugins.includes(e.tag)) &&
				(levels.length === 0 || levels.includes(e.level)) &&
				(!needle || e.text.toLowerCase().includes(needle) || e.tag.toLowerCase().includes(needle)),
		);
	}, [entries, plugins, levels, query]);

	return (
		<div className="col" style={{ gap: 12, height: '100%' }}>
			<div className="row wrap" style={{ gap: 9 }}>
				<div
					className="row"
					style={{
						gap: 8,
						background: 'var(--bg-panel)',
						border: '1px solid var(--line)',
						borderRadius: 'var(--r-sm)',
						padding: '0 10px',
						height: 32,
						flex: '1 1 240px',
						maxWidth: 380,
					}}
				>
					<Icon name="search" size={15} style={{ color: 'var(--tx-lo)' }} />
					<input
						value={query}
						onChange={(e: ChangeEvent<HTMLInputElement>) => setQuery(e.target.value)}
						placeholder="Search messages…"
						style={{
							background: 'transparent',
							border: 'none',
							outline: 'none',
							color: 'var(--tx-hi)',
							fontSize: 13,
							flex: 1,
							fontFamily: 'var(--font-mono)',
						}}
					/>
				</div>
				<MultiSelect
					label="Plugins"
					icon="puzzle"
					options={pluginOptions}
					selected={plugins}
					onToggle={togglePlugin}
				/>
				<MultiSelect
					label="Levels"
					icon="filter"
					options={LEVEL_OPTIONS}
					selected={levels}
					onToggle={toggleLevel}
				/>
				<div className="grow" />
				<span
					className="row"
					style={{ gap: 6, fontSize: 12, color: 'var(--tx-lo)' }}
					title="The projection exposes a static log tail per plugin — no live stream yet."
				>
					<Dot token="dim" />
					Tail · static
				</span>
			</div>

			<div className="panel logbox-full mono scroll-y grow">
				{filtered.length === 0 ? (
					<EmptyState
						icon="terminal"
						title="No matching log lines"
						hint="Adjust the filters or search to surface plugin output."
					/>
				) : (
					<>
						{filtered.map((entry, i) => (
							<div key={entry.id} className="logline">
								<span
									className="tnum"
									style={{ color: 'var(--tx-dim)', fontSize: 11, minWidth: 30 }}
								>
									{i + 1}
								</span>
								<LevelPill level={entry.level} />
								<span style={{ color: 'var(--tx-lo)', fontSize: 11.5, minWidth: 96 }}>
									{entry.tag}
								</span>
								<span style={{ color: LOG_LEVEL_COLOR[entry.level], fontSize: 12.5, flex: 1 }}>
									{entry.text}
								</span>
							</div>
						))}
						{truncated && (
							<div
								className="logline"
								style={{ color: 'var(--tx-dim)', fontSize: 11.5, fontStyle: 'italic' }}
							>
								older lines truncated — only the recent tail is retained per plugin
							</div>
						)}
					</>
				)}
			</div>
		</div>
	);
};

// --- Events -----------------------------------------------------------------

const EventsView = ({ activity }: Pick<PanelProps, 'activity'>) => {
	if (activity.length === 0) {
		return (
			<EmptyState
				icon="activity"
				title="No activity yet"
				hint="Status changes, endpoints, and errors appear here as the projection updates."
			/>
		);
	}
	return (
		<div className="panel scroll-y grow" style={{ padding: '6px 4px', height: '100%' }}>
			{activity.map((item) => {
				const token = item.section === 'other' ? 'white' : sectionToken(item.section);
				const clickable = item.pluginKey !== null;
				return (
					<div
						key={item.id}
						className="row fade-up"
						onClick={
							clickable ? () => navigate('services', item.pluginKey ?? undefined) : undefined
						}
						style={{
							gap: 9,
							padding: '6px 10px',
							borderRadius: 7,
							cursor: clickable ? 'pointer' : 'default',
						}}
					>
						<span className="mono" style={{ fontSize: 11, color: 'var(--tx-dim)', minWidth: 40 }}>
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
						<span className="trunc grow" style={{ fontSize: 12.5, color: 'var(--tx-mid)' }}>
							{item.text}
						</span>
						{item.pluginKey && (
							<Badge style={{ height: 18, fontSize: 10 }}>{labelForRow(item.pluginKey)}</Badge>
						)}
					</div>
				);
			})}
		</div>
	);
};

// --- Traces -----------------------------------------------------------------

const TracesView = () => (
	<div className="col" style={{ gap: 12, height: '100%' }}>
		<div
			className="panel panel-pad"
			style={{
				background: 'color-mix(in oklab, var(--c-blue) 6%, var(--bg-panel))',
				borderColor: 'color-mix(in oklab, var(--c-blue) 28%, var(--line))',
			}}
		>
			<div className="row" style={{ gap: 9 }}>
				<Icon name="activity" size={16} style={{ color: 'var(--c-blue)' }} />
				<span style={{ fontSize: 12.5, color: 'var(--tx-mid)' }}>
					Traces require the{' '}
					<span className="mono" style={{ color: 'var(--c-blue)' }}>
						SpanStore
					</span>{' '}
					tracer, which is not yet wired into the projection. No spans are available.
				</span>
			</div>
		</div>
		<div className="panel grow" style={{ display: 'grid', placeItems: 'center' }}>
			<EmptyState
				icon="activity"
				title="No spans collected"
				hint="Once the tracer lands, operations indexed by plugin / endpoint / op will appear here."
			/>
		</div>
	</div>
);
