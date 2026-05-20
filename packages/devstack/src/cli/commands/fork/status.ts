// `devstack fork status [--follow]` — print GetStatus one-shot, or
// stream checkpoint events with `--follow` (falls back to polling on
// stream error). Under --json each follow event is its own JSON line.

/* eslint-disable @typescript-eslint/no-explicit-any */

import { Console, Effect, Stream } from 'effect';
import { Command, Flag } from 'effect/unstable/cli';
import {
	subscribeCheckpointsWithFallback,
	type ForkCheckpointEvent,
} from '../../../engine/sui-fork/control.js';
import { failAlreadyReported } from '../../already-reported.js';
import { emitEnvelope, jsonModeEnabled, successEnvelope } from '../../envelope.js';
import {
	jsonFlag,
	makeForkClient,
	resolveStackAndForkCtx,
	stackFlag,
	wrapForkRpc,
} from './_shared.js';

const followFlag = Flag.boolean('follow').pipe(
	Flag.withDescription(
		'Stream `SubscribeCheckpoints` events instead of one-shot. ' +
			'Falls back to polling on stream error.',
	),
	Flag.withDefault(false),
);

export const statusCommand = Command.make(
	'status',
	{
		stack: stackFlag,
		json: jsonFlag,
		follow: followFlag,
	},
	({ stack, json, follow }) =>
		Effect.gen(function* () {
			const startedAt = Date.now();
			const useJson = jsonModeEnabled(json);
			const ctx = yield* resolveStackAndForkCtx(stack);
			const client = makeForkClient(ctx);
			const status = yield* wrapForkRpc('fork status: GetStatus', () =>
				client.forkingService.getStatus({}).response,
			);
			const body = {
				stack: ctx.stack,
				rpcUrl: ctx.rpcUrl,
				upstream: ctx.upstream,
				...(ctx.chainId !== undefined ? { chainId: ctx.chainId } : {}),
				forkedAtCheckpoint: Number(status.forkedAtCheckpoint),
				checkpointSequenceNumber: Number(status.checkpointSequenceNumber),
				epoch: Number(status.epoch),
				timestampMs: Number(status.timestampMs),
			};
			if (useJson) {
				yield* emitEnvelope(
					successEnvelope({
						command: 'fork.status',
						data: body,
						elapsedMs: Date.now() - startedAt,
					}),
				);
			} else {
				yield* Console.log(`fork status (stack='${ctx.stack}', upstream=${ctx.upstream}):`);
				if (ctx.chainId !== undefined) {
					yield* Console.log(`  chainId:                  ${ctx.chainId}`);
				}
				yield* Console.log(`  rpc:                      ${ctx.rpcUrl}`);
				yield* Console.log(`  forkedAtCheckpoint:       ${body.forkedAtCheckpoint}`);
				yield* Console.log(`  checkpointSequenceNumber: ${body.checkpointSequenceNumber}`);
				yield* Console.log(`  epoch:                    ${body.epoch}`);
				yield* Console.log(`  clockMs:                  ${body.timestampMs}`);
			}
			if (!follow) return;

			// `--follow` consumes the subscription stream until the
			// scope tears down (Ctrl-C) or the upstream completes.
			// Each event still emits as its own JSON line under --json
			// for backward compatibility — wrapping the stream of
			// events in a single envelope would defeat the point.
			yield* Console.log(
				useJson
					? ''
					: `following checkpoint stream (Ctrl-C to stop, source=subscription→poll on error)…`,
			);
			yield* subscribeCheckpointsWithFallback(client).pipe(
				Stream.runForEach((event: ForkCheckpointEvent) =>
					useJson
						? Console.log(JSON.stringify(event))
						: Console.log(
								`  [${new Date(event.receivedAtMs).toISOString()}] checkpoint=${event.cursor} (${event.source})`,
							),
				),
				Effect.catch((cause) =>
					failAlreadyReported(`fork status --follow: ${cause.message ?? String(cause)}`),
				),
			);
		}),
).pipe(
	Command.withDescription(
		"Print the running fork stack's `ForkingService.GetStatus` response. " +
			'Pass `--follow` to stream checkpoint events instead of one-shot.',
	),
);
