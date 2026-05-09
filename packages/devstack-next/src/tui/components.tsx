import { Box, Text, useApp, useInput } from 'ink';
import { useSyncExternalStore } from 'react';
import type { Engine } from '../engine/class.js';
import type { Env, NodeStatus, NodeView } from '../engine/types.js';
import type { Store } from './store.js';

const STATUS_GLYPH: Record<NodeStatus, string> = {
	idle: '·',
	running: '⟳',
	satisfied: '✓',
	errored: '✗',
	skipped: '–',
};

const STATUS_COLOR: Partial<Record<NodeStatus, string>> = {
	running: 'cyan',
	satisfied: 'green',
	errored: 'red',
	skipped: 'gray',
};

export interface AppProps {
	engine: Engine;
	env: Env;
	store: Store;
	/** Side-channel for caller-driven actions (s for save, q for quit).
	 * Resolved when the user requests shutdown so the host CLI can
	 * coordinate engine.stop() + flush. */
	onQuit: () => void;
	onSave: () => void;
	onRetry: (name: string) => void;
}

export function App(props: AppProps): React.ReactElement {
	const snap = useSyncExternalStore(props.store.subscribe, props.store.getSnapshot);
	const inkApp = useApp();

	useInput((input, _key) => {
		if (input === 'q') {
			props.onQuit();
			inkApp.exit();
		} else if (input === 's') {
			props.onSave();
		} else if (input === 'r') {
			// Retry every errored node — saves the user from naming them.
			for (const view of snap.state.nodes.values()) {
				if (view.status === 'errored') props.onRetry(view.name);
			}
		}
	});

	const cycle = snap.state.cycle;
	const nodes = [...snap.state.nodes.values()];

	return (
		<Box flexDirection="column">
			<Header env={props.env} cycleId={cycle.id} cycleStatus={cycle.status} />
			<StatusTable nodes={nodes} />
			<Tail lines={snap.tail} />
			<Footer />
		</Box>
	);
}

function Header(props: {
	env: Env;
	cycleId: number;
	cycleStatus: 'idle' | 'running' | 'paused';
}): React.ReactElement {
	const target =
		props.env.network === 'localnet'
			? `${props.env.network} (stack=${props.env.stack ?? 'main'})`
			: props.env.network;
	return (
		<Box paddingX={1} borderStyle="round" borderColor="gray">
			<Text bold>{props.env.appName}</Text>
			<Text> · </Text>
			<Text>{target}</Text>
			<Text> · </Text>
			<Text dimColor>cycle {props.cycleId}</Text>
			<Text> </Text>
			<Text color={props.cycleStatus === 'running' ? 'cyan' : 'gray'}>
				[{props.cycleStatus}]
			</Text>
		</Box>
	);
}

function StatusTable(props: { nodes: NodeView[] }): React.ReactElement {
	if (props.nodes.length === 0) {
		return (
			<Box paddingX={1}>
				<Text dimColor>no nodes in stack</Text>
			</Box>
		);
	}
	return (
		<Box flexDirection="column" paddingX={1}>
			{props.nodes.map((view) => (
				<NodeRow key={view.name} view={view} />
			))}
		</Box>
	);
}

function NodeRow(props: { view: NodeView }): React.ReactElement {
	const { view } = props;
	const glyph = STATUS_GLYPH[view.status];
	const color = STATUS_COLOR[view.status];
	const lastLog = view.logs.at(-1);
	return (
		<Box>
			<Box width={3}>
				<Text color={color}>{glyph}</Text>
			</Box>
			<Box width={32}>
				<Text>{view.name}</Text>
			</Box>
			<Box width={11}>
				<Text color={color} dimColor={view.status === 'idle'}>
					{view.status}
				</Text>
			</Box>
			<Box flexGrow={1}>
				{view.lastError !== undefined ? (
					<Text color="red">{view.lastError.message}</Text>
				) : lastLog !== undefined ? (
					<Text dimColor>{lastLog}</Text>
				) : null}
			</Box>
		</Box>
	);
}

function Tail(props: { lines: string[] }): React.ReactElement | null {
	if (props.lines.length === 0) return null;
	return (
		<Box flexDirection="column" paddingX={1} marginTop={1}>
			{props.lines.map((line, i) => (
				// Tail lines are append-only; index keys are stable enough for
				// the small fixed window without forcing us to invent a uuid.
				// eslint-disable-next-line react/no-array-index-key
				<Text key={i} dimColor>
					{line}
				</Text>
			))}
		</Box>
	);
}

function Footer(): React.ReactElement {
	return (
		<Box paddingX={1} marginTop={1}>
			<Text dimColor>q quit · s save snapshot · r retry errored</Text>
		</Box>
	);
}
