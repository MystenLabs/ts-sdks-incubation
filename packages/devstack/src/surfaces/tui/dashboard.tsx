// Dashboard — composes the visible TUI: header, rows, endpoints,
// errors, log tails, heartbeat.
//
// Reads ONLY the typed projection (`SubscribableState`). Calls the
// pure derivation helpers in `display-derivation.ts` for every visible
// cell. The dashboard does NOT subscribe to the SubscriptionRef
// itself — `app.tsx` owns the subscription and feeds `state` in as a
// prop. This keeps the dashboard pure-render-of-state, which is what
// the architecture's "frame stability" invariant requires.

import { Box, Static, Text } from 'ink';
import type React from 'react';

import type { SubscribableState } from '../../substrate/projection.ts';
import { DetailPane } from './detail-pane.tsx';
import { EndpointRenderer } from './endpoint-renderer.tsx';
import { ErrorPane } from './error-pane.tsx';
import type { EventLogLine } from './event-log.ts';
import { Heartbeat } from './heartbeat.tsx';
import { LogPane } from './log-pane.tsx';
import { RowRenderer } from './row-renderer.tsx';
import { groupRows } from './display-derivation.ts';

const phaseColor = (
	phase: SubscribableState['cycle']['phase'],
): 'green' | 'yellow' | 'red' | 'gray' => {
	switch (phase) {
		case 'running':
			return 'green';
		case 'booting':
		case 'restarting':
			return 'yellow';
		case 'shutting-down':
			return 'red';
		default:
			return 'gray';
	}
};

export interface DashboardProps {
	readonly state: SubscribableState;
	readonly eventLog: ReadonlyArray<EventLogLine>;
	readonly selectedRowKey: string | null;
}

const logColor = (level: EventLogLine['level']): 'gray' | 'yellow' | 'red' => {
	switch (level) {
		case 'info':
			return 'gray';
		case 'warn':
			return 'yellow';
		case 'error':
			return 'red';
	}
};

export const Dashboard = ({
	state,
	eventLog,
	selectedRowKey,
}: DashboardProps): React.JSX.Element => {
	const { identity, cycle, rows, endpoints, errors } = state;
	const selectedRow =
		rows.find((row) => row.key === selectedRowKey) ??
		rows.find((row) => row.status === 'failed') ??
		rows[0] ??
		null;
	const sections = groupRows(rows, endpoints);

	return (
		<Box flexDirection="column">
			{eventLog.length > 0 && (
				<Static items={[...eventLog]}>
					{(entry) => (
						<Text key={entry.id} color={logColor(entry.level)}>
							{entry.text}
						</Text>
					)}
				</Static>
			)}

			{state.stackBuild.length > 0 && (
				<Static items={[...state.stackBuild]}>
					{(entry, idx) => (
						<Text key={idx} color="gray">
							[build] {entry.pluginKey ?? '<stack>'} - {entry.phase} {entry.progress}
						</Text>
					)}
				</Static>
			)}

			{/* Header — identity + cycle + heartbeat */}
			<Box flexDirection="row" gap={2}>
				<Text bold color="cyan">
					{identity.app}/{identity.stack}
				</Text>
				<Text color="gray">network={identity.network}</Text>
				<Text color="gray">cycle={cycle.id}</Text>
				<Text color={phaseColor(cycle.phase)}>{cycle.phase}</Text>
				<Heartbeat />
			</Box>

			{/* Rows */}
			<Box flexDirection="column" marginTop={1}>
				<Text bold>Stack</Text>
				{rows.length === 0 && <Text color="gray">no plugins declared</Text>}
				{sections.map((section) => (
					<Box key={section.key} flexDirection="column">
						<Text bold color="gray">
							{section.label}
						</Text>
						{section.rows.map(({ row }) => (
							<RowRenderer
								key={row.key}
								row={row}
								endpoints={endpoints}
								selected={selectedRow?.key === row.key}
							/>
						))}
					</Box>
				))}
			</Box>

			{/* Endpoints */}
			<Box flexDirection="column" marginTop={1}>
				<EndpointRenderer endpoints={endpoints} />
			</Box>

			{/* Errors */}
			<Box flexDirection="column" marginTop={1}>
				<ErrorPane errors={errors} />
			</Box>

			<Box flexDirection="column" marginTop={1}>
				<DetailPane row={selectedRow} endpoints={endpoints} />
			</Box>

			<Box flexDirection="column" marginTop={1}>
				{selectedRow === null ? (
					<Text color="gray">No logs selected</Text>
				) : (
					<LogPane row={selectedRow} />
				)}
			</Box>

			{/* Footer — keymap hint */}
			<Box flexDirection="row" gap={2} marginTop={1}>
				<Text color="gray">[q] quit</Text>
				<Text color="gray">[up/down] focus</Text>
				<Text color="gray">[r] restart</Text>
				<Text color="gray">[s] snapshot</Text>
			</Box>
		</Box>
	);
};
