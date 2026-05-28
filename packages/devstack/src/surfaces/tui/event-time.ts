// Shared event-time projection for the TUI renderers.
//
// Both the rich (`event-log.ts`) and plain (`plain-renderer.ts`) renderers
// need to project the producer-time of an `EngineEvent` for display. The
// switch is intentionally exhaustive — every variant carries an
// authoritative timestamp either at the top level (`event.at`) or in a
// domain-specific nested field (`endpoint.registered.endpoint.registeredAt`,
// `error.reported.error.at`, `build.statusChanged.entry.startedAt`) — so
// the compiler enforces that any newly-added event variant must declare
// where its timestamp lives.
//
// Removing the historical `Date.now()` fallback is load-bearing. Under
// back-pressure (a queued event flushed late from the dispatcher) the
// dequeue-time fallback would back-date or forward-date the log entry,
// producing apparent event-time reordering in the rendered log. Pinning
// the time to the producer's record preserves the ordering tests assert.
// The `default` arm still returns `Date.now()` so a runtime that somehow
// receives an unknown shape doesn't throw inside the event-log path.

import type { EngineEvent } from '../../substrate/events.ts';

export const eventAt = (event: EngineEvent): number => {
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
			return Date.now();
		}
	}
};
