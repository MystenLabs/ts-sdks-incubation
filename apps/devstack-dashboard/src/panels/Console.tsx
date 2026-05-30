// Console panel — three views over the live observability surfaces:
//
//   • Logs   — cross-service log rings via `fetchLogs`; follow/pause + filters.
//   • Events — the client-derived `activity` feed (projection diff, newest-first).
//   • Traces — completed spans from the SpanStore tracer via `fetchSpans`.
//
// The tab subcomponents live under `panels/console/*`. Data flows from the
// `PanelProps` `endpoint` (server-side filtered queries) and the `activity`
// feed; nothing is fabricated — empty backends yield honest empty states.

import { useState } from 'react';
import type { PanelProps } from './types.ts';
import { Segmented } from '../ui/index.ts';
import { LogsTab } from './console/LogsTab.tsx';
import { EventsTab } from './console/EventsTab.tsx';
import { TracesTab } from './console/TracesTab.tsx';

type ConsoleTab = 'logs' | 'events' | 'traces';

const TABS = [
	{ value: 'logs' as const, label: 'Logs' },
	{ value: 'events' as const, label: 'Events' },
	{ value: 'traces' as const, label: 'Traces' },
];

export const ConsolePanel = ({ endpoint, activity }: PanelProps) => {
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
					<LogsTab endpoint={endpoint} />
				) : tab === 'events' ? (
					<EventsTab activity={activity} />
				) : (
					<TracesTab endpoint={endpoint} />
				)}
			</div>
		</div>
	);
};
