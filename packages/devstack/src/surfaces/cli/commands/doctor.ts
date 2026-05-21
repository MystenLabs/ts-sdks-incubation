// CLI verb: `devstack doctor` — health check / lint of the user's
// stack.
//
// Architecture (distilled/20-cli.md § Subcommands § Diagnostic):
//   "doctor — preflight check matrix + environment inventory,
//    optionally cleaning stale locks."
//
// Doctor runs a fixed set of probes. Each probe returns a typed
// outcome (ok | warn | fail | unavailable); the verb projects them
// into the JSON data block / human table. Probes are pluggable —
// the dispatcher composes the L1 docker probe, the move-build-lock
// probe, the port-allocator probe, etc. The CLI just orchestrates.
//
// Surface invariant (architecture § Learnings): "Doctor's port probe
// must mirror the engine." — the probes themselves must be wired to
// the same primitives the engine uses.

import { Effect } from 'effect';

import { type CliError, CliUnavailableError } from '../errors.ts';
import { emitSuccess } from '../output.ts';
import type { CommandContext, CommandResult } from './index.ts';

export type ProbeOutcome =
	| { readonly status: 'ok'; readonly detail?: string }
	| { readonly status: 'warn'; readonly detail: string }
	| { readonly status: 'fail'; readonly detail: string }
	| { readonly status: 'unavailable'; readonly detail: string };

export interface Probe {
	readonly name: string;
	readonly description: string;
	readonly required: boolean;
	readonly run: () => Effect.Effect<ProbeOutcome>;
}

export interface ProbeReport {
	readonly name: string;
	readonly description: string;
	readonly required: boolean;
	readonly outcome: ProbeOutcome;
}

export interface DoctorDeps {
	readonly probes: ReadonlyArray<Probe>;
}

export const runDoctor = (
	deps: DoctorDeps,
	ctx: CommandContext,
): Effect.Effect<CommandResult, CliError> =>
	Effect.gen(function* () {
		const started = Date.now();
		const reports: Array<ProbeReport> = [];
		for (const probe of deps.probes) {
			const outcome = yield* probe.run();
			reports.push({
				name: probe.name,
				description: probe.description,
				required: probe.required,
				outcome,
			});
		}
		const requiredFailures = reports.filter(
			(
				r,
			): r is ProbeReport & {
				outcome: Extract<ProbeOutcome, { status: 'fail' | 'unavailable' }>;
			} => r.required && (r.outcome.status === 'fail' || r.outcome.status === 'unavailable'),
		);
		if (requiredFailures.length > 0) {
			// Surface the first required-failure as an `Unavailable`
			// error so the exit code is `EX_UNAVAILABLE` (architecture
			// edge-case: "Docker daemon unreachable → doctor surfaces a
			// required-check failure with the unavailable exit code").
			const first = requiredFailures[0]!;
			return yield* Effect.fail(
				new CliUnavailableError({
					message: first.outcome.detail,
					service: first.name,
					hint: first.outcome.detail,
				}),
			);
		}
		const humanLines = reports.map(
			(r) =>
				`${r.outcome.status.padEnd(11, ' ')} ${r.name}${
					r.outcome.status !== 'ok' && 'detail' in r.outcome ? ` — ${r.outcome.detail ?? ''}` : ''
				}`,
		);
		yield* emitSuccess(ctx.io, ctx.flags.outputMode, {
			command: 'doctor',
			elapsedMs: Date.now() - started,
			data: { reports },
			humanLines,
		});
		return { exitCode: 0 } as CommandResult;
	}).pipe(Effect.withSpan('cli.doctor'));
