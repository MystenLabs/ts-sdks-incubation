// Producer-time projection for `EngineEvent`.
//
// Every event variant carries an authoritative timestamp either at the
// top level (`event.at`) or in a domain-specific nested field
// (`endpoint.registered.endpoint.registeredAt`, `error.reported.error.at`,
// `build.statusChanged.entry.startedAt`). The switch is intentionally
// exhaustive so a newly-added variant must declare where its timestamp
// lives — the compiler enforces it via the `never`-assignment default.
//
// Two shapes:
//   - `eventAtOrNull` (substrate-layer consumers): returns `null` when
//     the variant has no inherent timestamp, letting the caller fall
//     back to whatever stale value preserves invariants (e.g. the
//     projection update reducer keeps `state.lastEvent.at` on miss).
//   - `eventAt` (UI consumers): wraps `eventAtOrNull` with a `Date.now()`
//     fallback so log rendering always gets a number. It pins to the
//     producer's record rather than a dequeue-time stamp: under back-
//     pressure (a queued event flushed late from the dispatcher) a
//     dequeue-time stamp would back-date or forward-date the log entry,
//     producing apparent event-time reordering in the rendered log.
//     Pinning to the producer's record preserves the ordering tests
//     assert.

import type { EngineEvent } from './events.ts';

export const eventAtOrNull = (event: EngineEvent): number | null => {
	switch (event.tag) {
		case 'endpoint.registered':
			return event.endpoint.registeredAt;
		case 'error.reported':
			return event.error.at;
		case 'build.statusChanged':
			return event.entry.startedAt;
		case 'lifecycle.statusChanged':
		case 'lifecycle.phaseSet':
		case 'log.appended':
		case 'projection.updated':
		case 'endpoint.released':
		case 'strategy.registered':
		case 'strategy.unregistered':
		case 'manifest.flushed':
		case 'codegen.emitted':
		case 'restart.requested':
		case 'restart.completed':
		case 'shutdown.escalated':
		case 'snapshot.captureStarted':
		case 'snapshot.captureProgress':
		case 'snapshot.captureSkipped':
		case 'snapshot.captureFailed':
		case 'snapshot.captured':
		case 'snapshot.restored':
		case 'engine.orchestrator.dispatchFailed':
			return event.at;
		default: {
			const _exhaustive: never = event;
			void _exhaustive;
			return null;
		}
	}
};

export const eventAt = (event: EngineEvent): number => eventAtOrNull(event) ?? Date.now();
