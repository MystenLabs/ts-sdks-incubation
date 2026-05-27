// Ink app root — the React tree mounted by `render()`.
//
// Reads from the `SubscriptionRef<SubscribableState>` from the
// substrate's projection layer. The initial render samples the current
// value synchronously; subsequent frame updates come from the
// subscription. No polling loops, no setInterval-driven sampling.
// The heartbeat component spins on its own timer for liveness, but
// it does NOT trigger dashboard re-renders for projection data.
//
// Per architecture (distilled/21-tui § Learnings #3 + § Invariants):
//   - The renderer NEVER calls engine methods. Input handlers publish
//     typed `EngineCommand`s through the `publish` callback prop.
//   - Mount is process-scoped and survives engine cycle swaps; the
//     SubscriptionRef's lifecycle is decoupled from the engine cycle.
//   - Frame stability: SubscriptionRef updates already short-circuit
//     when reference equality holds (Effect's Ref impl).
//
// Runtime escape note: `Effect.runFork` is necessary at the
// SubscriptionRef → React state boundary (React's hook model is
// synchronous; Effect can't render). It is the ONLY escape this
// surface uses, scoped to the App's mount lifetime. This is the
// "properly-scoped fiber on each surface" pattern called out in
// distilled/21-tui § Opportunities.

import { Effect, Fiber, Stream, SubscriptionRef } from 'effect';
import type React from 'react';
import { useEffect, useRef, useState } from 'react';

import type { EngineEvent } from '../../substrate/events.ts';
import type { SubscribableState } from '../../substrate/projection.ts';
import { Dashboard, type SnapshotStatus } from './dashboard.tsx';
import {
	appendEventLogLine,
	eventLogLineFromEvent,
	shutdownRequestedLine,
	type EventLogLine,
} from './event-log.ts';
import { InputHandler, type CommandPublisher } from './input.tsx';

export interface AppProps {
	/** The renderer-facing subscribable projection. */
	readonly stateRef: SubscriptionRef.SubscriptionRef<SubscribableState>;
	/** Live engine event stream. */
	readonly events: Stream.Stream<EngineEvent, never>;
	/** Typed command-publisher callback. */
	readonly publish: CommandPublisher;
}

export const App = ({ stateRef, events, publish }: AppProps): React.JSX.Element => {
	const [state, setState] = useState<SubscribableState>(() =>
		Effect.runSync(SubscriptionRef.get(stateRef)),
	);
	const [eventLog, setEventLog] = useState<ReadonlyArray<EventLogLine>>([]);
	const [snapshotPromptValue, setSnapshotPromptValue] = useState<string | null>(null);
	const [snapshotStatus, setSnapshotStatus] = useState<SnapshotStatus | null>(null);
	const eventSeq = useRef(0);
	const shutdownLogged = useRef(false);
	// Latest projection rows for `sectionLookup`. Held in a ref so the
	// event-subscription effect doesn't re-fire when state changes — it
	// reads the up-to-date snapshot through the ref instead.
	const rowsRef = useRef(state.rows);
	rowsRef.current = state.rows;

	useEffect(() => {
		// Stream.runForEach pulls each new state from the
		// SubscriptionRef and pushes it into React state. The fiber is
		// owned by this effect; cleanup interrupts it.
		const fiber = Effect.runFork(
			Stream.runForEach(SubscriptionRef.changes(stateRef), (next) =>
				Effect.sync(() => setState(next)),
			),
		);
		return () => {
			// Interrupt the subscription fiber on unmount.
			Effect.runFork(Fiber.interrupt(fiber));
		};
	}, [stateRef]);

	useEffect(() => {
		const sectionLookup = (pluginKey: string) =>
			rowsRef.current.find((row) => row.key === pluginKey)?.section;
		const fiber = Effect.runFork(
			Stream.runForEach(events, (event) =>
				Effect.sync(() => {
					const line = eventLogLineFromEvent(event, eventSeq.current++, sectionLookup);
					setEventLog((prev) => appendEventLogLine(prev, line));
					switch (event.tag) {
						case 'snapshot.captureStarted':
							setSnapshotStatus({
								tag: 'running',
								phase: 'starting',
								...(event.snapshotId === undefined ? {} : { snapshotId: event.snapshotId }),
								...(event.name === undefined ? {} : { name: event.name }),
								at: event.at,
							});
							break;
						case 'snapshot.captureProgress':
							setSnapshotStatus((prev) => ({
								tag: 'running',
								phase: event.phase,
								...(event.snapshotId === undefined
									? prev?.tag === 'running' && prev.snapshotId !== undefined
										? { snapshotId: prev.snapshotId }
										: {}
									: { snapshotId: event.snapshotId }),
								...(event.name === undefined
									? prev?.tag === 'running' && prev.name !== undefined
										? { name: prev.name }
										: {}
									: { name: event.name }),
								...(event.detail === undefined ? {} : { detail: event.detail }),
								...(event.pausedContainers === undefined
									? {}
									: { pausedContainers: event.pausedContainers }),
								...(event.totalContainers === undefined
									? {}
									: { totalContainers: event.totalContainers }),
								at: event.at,
							}));
							break;
						case 'snapshot.captureSkipped':
							setSnapshotStatus({
								tag: 'skipped',
								reason: event.reason,
								at: event.at,
							});
							break;
						case 'snapshot.captureFailed':
							setSnapshotStatus({
								tag: 'failed',
								...(event.snapshotId === undefined ? {} : { snapshotId: event.snapshotId }),
								...(event.name === undefined ? {} : { name: event.name }),
								summary: event.summary,
								at: event.at,
							});
							break;
						case 'snapshot.captured':
							setSnapshotStatus({
								tag: 'captured',
								snapshotId: event.snapshotId,
								...(event.name === undefined ? {} : { name: event.name }),
								at: event.at,
							});
							break;
						default:
							break;
					}
				}),
			),
		);
		return () => {
			Effect.runFork(Fiber.interrupt(fiber));
		};
	}, [events]);

	useEffect(() => {
		if (state.cycle.phase === 'shutting-down') {
			setSnapshotPromptValue(null);
			setSnapshotStatus(null);
			if (shutdownLogged.current) return;
			shutdownLogged.current = true;
			const line = shutdownRequestedLine(Date.now(), eventSeq.current++);
			setEventLog((prev) => appendEventLogLine(prev, line));
			return;
		}
		shutdownLogged.current = false;
	}, [state.cycle.phase]);

	return (
		<>
			<InputHandler
				publish={publish}
				snapshotPromptValue={snapshotPromptValue}
				onSnapshotPromptChange={setSnapshotPromptValue}
			/>
			<Dashboard
				state={state}
				eventLog={eventLog}
				snapshotPromptValue={snapshotPromptValue}
				snapshotStatus={snapshotStatus}
			/>
		</>
	);
};
