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
import { EndpointRenderer } from './endpoint-renderer.tsx';
import { ErrorPane } from './error-pane.tsx';
import { Heartbeat } from './heartbeat.tsx';
import { LogPane } from './log-pane.tsx';
import { RowRenderer } from './row-renderer.tsx';

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
}

export const Dashboard = ({ state }: DashboardProps): React.JSX.Element => {
	const { identity, cycle, rows, endpoints, errors } = state;
	const failedRow = rows.find((r) => r.status === 'failed');
	const logRow = failedRow ?? rows.find((r) => r.status === 'acquiring');

	return (
		<Box flexDirection="column">
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

			{/* Build entries — engine-emitted progress lines for plugins
			    currently in `acquiring`. Pinned above the dashboard via
			    Ink's Static so they don't re-render. */}
			{state.stackBuild.length > 0 && (
				<Static items={[...state.stackBuild]}>
					{(entry, idx) => (
						<Text key={idx} color="gray">
							[build] {entry.pluginKey ?? '<stack>'} — {entry.phase} {entry.progress}
						</Text>
					)}
				</Static>
			)}

			{/* Rows */}
			<Box flexDirection="column" marginTop={1}>
				<Text bold>Plugins</Text>
				{rows.length === 0 && <Text color="gray">no plugins declared</Text>}
				{rows.map((row) => (
					<RowRenderer key={row.key} row={row} />
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

			{/* Log tail — shown for the failed row if one exists; else
			    the first acquiring row's tail; else nothing. */}
			{logRow && (
				<Box flexDirection="column" marginTop={1}>
					<LogPane row={logRow} />
				</Box>
			)}

			{/* Footer — keymap hint */}
			<Box flexDirection="row" gap={2} marginTop={1}>
				<Text color="gray">[q] quit</Text>
				<Text color="gray">[r] restart</Text>
				<Text color="gray">[s] snapshot</Text>
			</Box>
		</Box>
	);
};
