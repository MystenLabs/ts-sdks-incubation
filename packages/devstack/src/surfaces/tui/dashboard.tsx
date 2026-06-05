// Dashboard — composes the visible TUI: header, rows, endpoints,
// log tails, heartbeat.
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
import type { EventLogLine } from './event-log.ts';
import { Heartbeat } from './heartbeat.tsx';
import { ResourceTables } from './resource-table.tsx';
import { dashboardSummaryLine, deriveDashboardSummary } from './display-derivation.ts';

const phaseColor = (
	phase: SubscribableState['cycle']['phase'],
): 'green' | 'yellow' | 'red' | 'white' => {
	switch (phase) {
		case 'running':
			return 'green';
		case 'booting':
		case 'restarting':
			return 'yellow';
		case 'shutting-down':
			return 'red';
		default:
			return 'white';
	}
};

export interface DashboardProps {
	readonly state: SubscribableState;
	readonly eventLog: ReadonlyArray<EventLogLine>;
	readonly snapshotPromptValue: string | null;
	readonly snapshotStatus: SnapshotStatus | null;
}

export type SnapshotStatus =
	| {
			readonly tag: 'captured';
			readonly snapshotId: string;
			readonly name?: string;
			readonly at: number;
	  }
	| {
			readonly tag: 'skipped';
			readonly reason: 'already-running';
			readonly at: number;
	  }
	| {
			readonly tag: 'failed';
			readonly snapshotId?: string;
			readonly name?: string;
			readonly summary: string;
			readonly at: number;
	  };

const logMessageColor = (level: EventLogLine['level']): 'white' | 'yellow' | 'red' => {
	switch (level) {
		case 'info':
			return 'white';
		case 'warn':
			return 'yellow';
		case 'error':
			return 'red';
	}
};

const healthColor = (
	health: ReturnType<typeof deriveDashboardSummary>['health'],
): 'green' | 'yellow' | 'red' | 'white' => {
	switch (health) {
		case 'ready':
			return 'green';
		case 'active':
			return 'yellow';
		case 'blocked':
			return 'red';
		case 'empty':
			return 'white';
	}
};

const snapshotLabel = (status: SnapshotStatus): string => {
	if ('name' in status && status.name !== undefined) return status.name;
	if ('snapshotId' in status && status.snapshotId !== undefined) return status.snapshotId;
	return 'manual snapshot';
};

const SnapshotStatusLine = ({ status }: { readonly status: SnapshotStatus }): React.JSX.Element => {
	switch (status.tag) {
		case 'captured':
			return (
				<Box flexDirection="row" gap={1} marginTop={1}>
					<Text color="green">Snapshot:</Text>
					<Text>{snapshotLabel(status)}</Text>
					<Text color="green">saved</Text>
					<Text dimColor>{status.snapshotId}</Text>
				</Box>
			);
		case 'skipped':
			return (
				<Box flexDirection="row" gap={1} marginTop={1}>
					<Text color="yellow">Snapshot:</Text>
					<Text color="yellow">capture already running</Text>
				</Box>
			);
		case 'failed':
			return (
				<Box flexDirection="row" gap={1} marginTop={1}>
					<Text color="red">Snapshot:</Text>
					<Text>{snapshotLabel(status)}</Text>
					<Text color="red">failed</Text>
					<Text dimColor>{status.summary}</Text>
				</Box>
			);
	}
};

export const Dashboard = ({
	state,
	eventLog,
	snapshotPromptValue,
	snapshotStatus,
}: DashboardProps): React.JSX.Element => {
	const { identity, cycle, rows, endpoints, accounts, packages } = state;
	const summary = deriveDashboardSummary(state);

	return (
		<Box flexDirection="column">
			{eventLog.length > 0 && (
				<Static items={[...eventLog]}>
					{(entry) => (
						<Box key={entry.id} flexDirection="row" gap={1}>
							<Text dimColor>{entry.time}</Text>
							<Text color={entry.scopeColor}>{entry.scope}</Text>
							<Text color={logMessageColor(entry.level)}>{entry.message}</Text>
						</Box>
					)}
				</Static>
			)}

			{state.stackBuild.length > 0 && (
				<Static items={[...state.stackBuild]}>
					{(entry, idx) => (
						<Text key={idx} dimColor>
							[build] {entry.pluginKey ?? '<stack>'} - {entry.phase} {entry.progress}
						</Text>
					)}
				</Static>
			)}

			{/* Header — identity + cycle + heartbeat */}
			<Box flexDirection="row" gap={2} marginTop={1}>
				<Text bold color="cyan">
					{identity.app}/{identity.stack}
				</Text>
				<Text dimColor>network={identity.network}</Text>
				<Text dimColor>cycle={cycle.id}</Text>
				<Text color={phaseColor(cycle.phase)}>{cycle.phase}</Text>
				<Heartbeat />
			</Box>
			<Box>
				<Text color={healthColor(summary.health)}>{dashboardSummaryLine(summary)}</Text>
			</Box>

			<Box flexDirection="column" marginTop={1}>
				<ResourceTables rows={rows} endpoints={endpoints} accounts={accounts} packages={packages} />
			</Box>

			{snapshotPromptValue !== null && (
				<Box flexDirection="row" gap={1} marginTop={1}>
					<Text color="cyan">Snapshot name:</Text>
					<Text>{snapshotPromptValue.length === 0 ? '<auto>' : snapshotPromptValue}</Text>
					<Text inverse> </Text>
					<Text dimColor>Enter save Esc cancel</Text>
				</Box>
			)}

			{snapshotStatus !== null && <SnapshotStatusLine status={snapshotStatus} />}

			{/* Footer — commands. */}
			<Box flexDirection="row" gap={2} marginTop={1}>
				<Text>[q] quit</Text>
				<Text>[r] restart stack</Text>
				<Text>[s] snapshot name</Text>
			</Box>
		</Box>
	);
};
