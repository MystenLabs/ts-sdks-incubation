// `devstack fork replay-to <checkpoint>`
//
// Repeatedly `AdvanceCheckpoint` until the local sequence number
// reaches the target. Useful when running a script against a specific
// checkpoint anchor. Emits `noop: true` if already at/past target.

/* eslint-disable @typescript-eslint/no-explicit-any */

import { Console, Effect } from 'effect';
import { Argument, Command } from 'effect/unstable/cli';
import { failAlreadyReported } from '../../already-reported.js';
import { emitEnvelope, jsonModeEnabled, successEnvelope } from '../../envelope.js';
import {
	jsonFlag,
	makeForkClient,
	resolveStackAndForkCtx,
	stackFlag,
	wrapForkRpc,
} from './_shared.js';

export const replayToCommand = Command.make(
	'replay-to',
	{
		target: Argument.string('checkpoint').pipe(
			Argument.withDescription('Target local checkpoint sequence number'),
		),
		stack: stackFlag,
		json: jsonFlag,
	},
	({ target, stack, json }) =>
		Effect.gen(function* () {
			const startedAt = Date.now();
			const useJson = jsonModeEnabled(json);
			const parsedTarget = Number.parseInt(target, 10);
			if (!Number.isFinite(parsedTarget) || parsedTarget < 0) {
				return yield* failAlreadyReported(
					`fork replay-to: target must be a non-negative integer (got '${target}')`,
				);
			}
			const ctx = yield* resolveStackAndForkCtx(stack);
			const client = makeForkClient(ctx);
			const initial = yield* wrapForkRpc('fork replay-to: GetStatus', () =>
				client.forkingService.getStatus({}).response,
			);
			let current = Number(initial.checkpointSequenceNumber);
			if (current >= parsedTarget) {
				const body = {
					stack: ctx.stack,
					target: parsedTarget,
					initial: current,
					final: current,
					advanced: 0,
					noop: true,
				};
				if (useJson) {
					yield* emitEnvelope(
						successEnvelope({
							command: 'fork.replay-to',
							data: body,
							elapsedMs: Date.now() - startedAt,
						}),
					);
					return;
				}
				yield* Console.log(
					`fork replay-to: no-op — already at checkpoint ${current} (>= target ${parsedTarget})`,
				);
				return;
			}
			let advanced = 0;
			while (current < parsedTarget) {
				const resp = yield* wrapForkRpc(
					`fork replay-to: AdvanceCheckpoint at ${current}/${parsedTarget}`,
					() => client.forkingService.advanceCheckpoint({}).response,
				);
				current = Number(resp.checkpointSequenceNumber);
				advanced += 1;
			}
			const body = {
				stack: ctx.stack,
				target: parsedTarget,
				initial: Number(initial.checkpointSequenceNumber),
				final: current,
				advanced,
				noop: false,
			};
			if (useJson) {
				yield* emitEnvelope(
					successEnvelope({
						command: 'fork.replay-to',
						data: body,
						elapsedMs: Date.now() - startedAt,
					}),
				);
				return;
			}
			yield* Console.log(
				`fork replay-to: advanced ${advanced} checkpoint${advanced === 1 ? '' : 's'} ` +
					`from ${body.initial} to ${current}`,
			);
		}),
).pipe(
	Command.withDescription(
		'Repeatedly advance-checkpoint until the local sequence reaches the target',
	),
);
