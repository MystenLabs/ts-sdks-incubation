// Ink app root — the React tree mounted by `render()`.
//
// Subscribes to the `SubscriptionRef<SubscribableState>` from the
// substrate's projection layer. The subscription is the SINGLE source
// of frame updates: no polling loops, no setInterval-driven sampling.
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
import { useEffect, useState } from 'react';

import type { EngineEvent } from '../../substrate/events.ts';
import type { SubscribableState } from '../../substrate/projection.ts';
import { Dashboard } from './dashboard.tsx';
import { appendEventLogLine, eventLogLineFromEvent, type EventLogLine } from './event-log.ts';
import { selectRowKey } from './display-derivation.ts';
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
	const [state, setState] = useState<SubscribableState | null>(null);
	const [eventLog, setEventLog] = useState<ReadonlyArray<EventLogLine>>([]);
	const [selectedRowKey, setSelectedRowKey] = useState<string | null>(null);

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
		let seq = 0;
		const fiber = Effect.runFork(
			Stream.runForEach(events, (event) =>
				Effect.sync(() => {
					const line = eventLogLineFromEvent(event, seq++);
					setEventLog((prev) => appendEventLogLine(prev, line));
				}),
			),
		);
		return () => {
			Effect.runFork(Fiber.interrupt(fiber));
		};
	}, [events]);

	useEffect(() => {
		if (state === null) return;
		if (state.rows.length === 0) {
			setSelectedRowKey(null);
			return;
		}
		setSelectedRowKey((current) =>
			current !== null && state.rows.some((row) => row.key === current)
				? current
				: state.rows[0]!.key,
		);
	}, [state]);

	const moveSelection = (delta: -1 | 1): void => {
		if (state === null) return;
		setSelectedRowKey((current) => selectRowKey(state.rows, current, delta));
	};

	return (
		<>
			<InputHandler publish={publish} onMoveSelection={moveSelection} />
			{state === null ? (
				<></>
			) : (
				<Dashboard state={state} eventLog={eventLog} selectedRowKey={selectedRowKey} />
			)}
		</>
	);
};
