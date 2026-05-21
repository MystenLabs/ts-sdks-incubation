// Action plugin — lifecycle phases.
//
// 16-action.md §"Lifecycle" pins the per-acquire ordering:
//
//   pending → discriminator-eval → cache-lookup → (hit + verify-ok) →
//             completed (no body run)
//   pending → discriminator-eval → cache-lookup → (miss OR verify-fail)
//             → building → executing → parse → completed
//
// On supervisor shutdown there is NO long-running fiber to drain
// (Action is one-shot — distilled doc §"Teardown" — "no markStopping
// / markStopped events are emitted"). The scope-close just runs.

/** Action lifecycle phase. */
export type ActionLifecyclePhase =
	| 'pending'
	| 'discriminator'
	| 'cache-lookup'
	| 'building'
	| 'executing'
	| 'parsing'
	| 'completed'
	| 'failed';
