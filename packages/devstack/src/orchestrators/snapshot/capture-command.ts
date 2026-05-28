// Shared `captureSnapshot` command primitive.
//
// This is the hoisted core of `EngineCommand` `snapshot.capture` —
// the single Effect both publishers reach for:
//
//   - The supervisor's command handler in `cli/wirings/up.ts`
//     consumes a queued `snapshot.capture` EngineCommand and forwards
//     its `{ snapshotId, name }` payload here (with `onProgress`
//     wired to `handlerCtx.publish` so progress lands on the engine
//     event stream).
//
//   - The CLI's direct/offline `snapshot save` path in
//     `cli/wirings/snapshot.ts` calls this from inside its one-shot
//     `superviseStackEffect` scope (no supervisor alive).
//
//   - A future web-dashboard command receiver lands here too — it
//     only needs the `SnapshotOrchestratorService` + `FileSystem` in
//     its layer stack, with no CLI wiring imported.
//
// The primitive's contract is intentionally narrow: it owns the
// EngineCommand-payload → orchestrator-call shape and nothing else.
// CLI-specific concerns (logger config, exit codes, ack/event
// shaping, error narration) stay at the call sites — this file
// MUST NOT bake them in.

import { Effect, FileSystem } from 'effect';

import type { SnapshotProgressReporter } from './capture.ts';
import type { SnapshotMetadata } from './descriptor.ts';
import {
	SnapshotOrchestratorService,
	type SnapshotOrchestratorError,
} from './service.ts';

/** Inputs mirror the `snapshot.capture` EngineCommand payload
 *  (`{ snapshotId?, name? }`) plus the optional progress reporter
 *  the supervisor wires into its event-publish bridge. The offline
 *  CLI path passes the same payload (from CLI flags) and omits
 *  `onProgress` (no engine stream to publish to). */
export interface CaptureSnapshotArgs {
	readonly snapshotId?: string;
	readonly name?: string;
	readonly onProgress?: SnapshotProgressReporter;
}

/** Capture a snapshot via the registered `SnapshotOrchestratorService`.
 *  Returns the orchestrator's typed `SnapshotMetadata` on success;
 *  fails with the orchestrator's tagged `SnapshotOrchestratorError`
 *  union (callers `catchTags` on the precise tags they care about).
 *
 *  The required context — `SnapshotOrchestratorService` and the
 *  `FileSystem` service the orchestrator's `capture` call consumes —
 *  flows in through the ambient Effect Context (NOT closure args);
 *  identity and stack-paths come transitively from the orchestrator
 *  layer's own requirements.
 */
export const captureSnapshot = (
	args: CaptureSnapshotArgs,
): Effect.Effect<
	SnapshotMetadata,
	SnapshotOrchestratorError,
	SnapshotOrchestratorService | FileSystem.FileSystem
> =>
	Effect.gen(function* () {
		const snapshot = yield* SnapshotOrchestratorService;
		return yield* snapshot.capture({
			id: args.snapshotId,
			label: args.name,
			onProgress: args.onProgress,
		});
	});
