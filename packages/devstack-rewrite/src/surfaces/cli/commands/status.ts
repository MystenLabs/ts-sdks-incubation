// CLI verb: `devstack status` — observational read of stack state.
//
// Architecture (distilled/20-cli.md § Subcommands § Lifecycle):
//   "status — observational read of stack state, manifest, and (if
//    present) fork meta."
//
// Surface invariant: status MUST tolerate missing/malformed state
// files. It describes what IS, not what should be. The architecture
// explicitly calls this out — throwing on a stack that hasn't been
// brought up would be a regression.

import { Effect } from 'effect';

import type { SubscribableState } from '../../../substrate/projection.ts';
import type { CliError } from '../errors.ts';
import { emitSuccess } from '../output.ts';
import type { CommandContext, CommandResult } from './index.ts';

/** Pure projection: `SubscribableState` → JSON-safe status blob.
 *  Never leaks substrate types. */
export const buildStatusPayload = (state: SubscribableState | null) => {
	if (state === null) {
		return {
			present: false as const,
			identity: null,
			cycle: null,
			rowCount: 0,
			endpointCount: 0,
			errorCount: 0,
		};
	}
	return {
		present: true as const,
		identity: { ...state.identity },
		cycle: { ...state.cycle },
		rowCount: state.rows.length,
		endpointCount: state.endpoints.length,
		errorCount: state.errors.length,
		rows: state.rows.map((r) => ({
			key: r.key as string,
			kind: r.kind,
			status: r.status,
			phase: r.phase,
			lastErrorTag: r.lastError?.tag ?? null,
		})),
		endpoints: state.endpoints.map((e) => ({
			endpointKey: e.endpointKey as string,
			name: e.name,
			url: e.displayUrl ?? e.url,
		})),
	};
};

/**
 * Status reader interface. The dispatcher wires this to the
 * substrate's projection ref via a thin reader; tests pass a stub.
 * The CLI never calls engine methods directly — it reads the same
 * projection any peer surface (TUI, programmable API) sees.
 */
export interface StatusReader {
	/** Resolve current projection for `(app, stack)`. Returns `null`
	 *  if no state has been written yet — that is a normal, tolerated
	 *  state for a freshly-defined stack. */
	readonly readState: (app: string, stack: string) => Effect.Effect<SubscribableState | null>;
}

export interface StatusDeps {
	readonly reader: StatusReader;
}

/**
 * Run `devstack status`. Tolerant of missing state. Always succeeds
 * (returns ok=true) unless the projection read itself raises (which
 * the reader contractually swallows for missing files).
 */
export const runStatus = (
	deps: StatusDeps,
	ctx: CommandContext,
): Effect.Effect<CommandResult, CliError> =>
	Effect.gen(function* () {
		const started = Date.now();
		// Resolve `(app, stack)` from flags. The dispatcher seeds these
		// from the precedence chain; if both are absent we still render
		// (the projection reader returns `null`).
		const app = ctx.flags.app ?? '';
		const stack = ctx.flags.stack ?? '';
		const state = yield* deps.reader.readState(app, stack);
		const data = buildStatusPayload(state);
		const elapsedMs = Date.now() - started;

		const humanLines: Array<string> = [];
		if (!data.present) {
			humanLines.push(
				`status: no state present for ${app || '(no app)'} / ${stack || '(no stack)'}`,
			);
		} else {
			humanLines.push(`app:     ${data.identity!.app}`);
			humanLines.push(`stack:   ${data.identity!.stack}`);
			humanLines.push(`network: ${data.identity!.network}`);
			humanLines.push(`cycle:   #${data.cycle!.id} ${data.cycle!.phase}`);
			humanLines.push(`rows:    ${data.rowCount}`);
			humanLines.push(`endpoints: ${data.endpointCount}`);
			humanLines.push(`errors:  ${data.errorCount}`);
		}

		yield* emitSuccess(ctx.io, ctx.flags.outputMode, {
			command: 'status',
			elapsedMs,
			data,
			humanLines,
		});
		return { exitCode: 0 } as CommandResult;
	}).pipe(Effect.withSpan('cli.status'));
