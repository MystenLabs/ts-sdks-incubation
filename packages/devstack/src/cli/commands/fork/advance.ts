// `devstack fork advance-clock <durationMs>` (AdvanceClock RPC) and
// `devstack fork advance-checkpoint [--count N]` (AdvanceCheckpoint
// looped N times). Both honour `--dry-run` (resolve + validate args,
// skip the RPC).

/* eslint-disable @typescript-eslint/no-explicit-any */

import { Console, Effect } from 'effect';
import { Argument, Command, Flag } from 'effect/unstable/cli';
import { failAlreadyReported } from '../../already-reported.js';
import { emitEnvelope, jsonModeEnabled, successEnvelope } from '../../envelope.js';
import {
	jsonFlag,
	makeForkClient,
	resolveStackAndForkCtx,
	stackFlag,
	wrapForkRpc,
} from './_shared.js';

export const advanceClockCommand = Command.make(
	'advance-clock',
	{
		duration: Argument.string('durationMs').pipe(
			Argument.withDescription('Milliseconds to advance the on-chain clock by'),
		),
		stack: stackFlag,
		json: jsonFlag,
		dryRun: Flag.boolean('dry-run').pipe(
			Flag.withDescription('Resolve the target and exit without invoking AdvanceClock'),
			Flag.withDefault(false),
		),
	},
	({ duration, stack, json, dryRun }) =>
		Effect.gen(function* () {
			const startedAt = Date.now();
			const useJson = jsonModeEnabled(json);
			const parsedDuration = Number.parseInt(duration, 10);
			if (!Number.isFinite(parsedDuration) || parsedDuration <= 0) {
				return yield* failAlreadyReported(
					`fork advance-clock: durationMs must be a positive integer (got '${duration}')`,
				);
			}
			const ctx = yield* resolveStackAndForkCtx(stack);
			if (dryRun) {
				if (useJson) {
					yield* emitEnvelope(
						successEnvelope({
							command: 'fork.advance-clock',
							data: {
								stack: ctx.stack,
								wouldAdvanceMs: parsedDuration,
								rpcUrl: ctx.rpcUrl,
							},
							elapsedMs: Date.now() - startedAt,
							dryRun: true,
						}),
					);
				} else {
					yield* Console.log(
						`would advance clock by ${parsedDuration}ms against ${ctx.rpcUrl} — dry run`,
					);
				}
				return;
			}
			const client = makeForkClient(ctx);
			const resp = yield* wrapForkRpc(
				'fork advance-clock: AdvanceClock',
				() => client.forkingService.advanceClock({ durationMs: BigInt(parsedDuration) }).response,
			);
			const body = {
				stack: ctx.stack,
				advancedMs: parsedDuration,
				newTimestampMs: Number(resp.timestampMs),
				txDigest: resp.txDigest,
			};
			if (useJson) {
				yield* emitEnvelope(
					successEnvelope({
						command: 'fork.advance-clock',
						data: body,
						elapsedMs: Date.now() - startedAt,
					}),
				);
				return;
			}
			yield* Console.log(
				`fork advance-clock: advanced by ${parsedDuration}ms; new clockMs=${body.newTimestampMs} ` +
					`(consensus-commit-prologue tx=${body.txDigest})`,
			);
		}),
).pipe(Command.withDescription("Advance the fork's on-chain clock by N milliseconds"));

export const advanceCheckpointCommand = Command.make(
	'advance-checkpoint',
	{
		count: Flag.string('count').pipe(
			Flag.withDescription('Number of checkpoints to advance (default 1)'),
			Flag.withDefault('1'),
		),
		stack: stackFlag,
		json: jsonFlag,
		dryRun: Flag.boolean('dry-run').pipe(
			Flag.withDescription('Resolve the target and exit without sealing checkpoints'),
			Flag.withDefault(false),
		),
	},
	({ count, stack, json, dryRun }) =>
		Effect.gen(function* () {
			const startedAt = Date.now();
			const useJson = jsonModeEnabled(json);
			const parsedCount = Number.parseInt(count, 10);
			if (!Number.isFinite(parsedCount) || parsedCount <= 0) {
				return yield* failAlreadyReported(
					`fork advance-checkpoint: --count must be a positive integer (got '${count}')`,
				);
			}
			const ctx = yield* resolveStackAndForkCtx(stack);
			if (dryRun) {
				if (useJson) {
					yield* emitEnvelope(
						successEnvelope({
							command: 'fork.advance-checkpoint',
							data: {
								stack: ctx.stack,
								wouldAdvanceCount: parsedCount,
								rpcUrl: ctx.rpcUrl,
							},
							elapsedMs: Date.now() - startedAt,
							dryRun: true,
						}),
					);
				} else {
					yield* Console.log(
						`would advance ${parsedCount} checkpoint${parsedCount === 1 ? '' : 's'} against ${ctx.rpcUrl} — dry run`,
					);
				}
				return;
			}
			const client = makeForkClient(ctx);
			const advances: Array<{ checkpointSequenceNumber: number; timestampMs: number }> = [];
			for (let i = 0; i < parsedCount; i++) {
				const resp = yield* wrapForkRpc(
					'fork advance-checkpoint: AdvanceCheckpoint',
					() => client.forkingService.advanceCheckpoint({}).response,
				);
				advances.push({
					checkpointSequenceNumber: Number(resp.checkpointSequenceNumber),
					timestampMs: Number(resp.timestampMs),
				});
			}
			const body = {
				stack: ctx.stack,
				count: parsedCount,
				advances,
				latestCheckpoint:
					advances.length > 0 ? advances[advances.length - 1]!.checkpointSequenceNumber : undefined,
			};
			if (useJson) {
				yield* emitEnvelope(
					successEnvelope({
						command: 'fork.advance-checkpoint',
						data: body,
						elapsedMs: Date.now() - startedAt,
					}),
				);
				return;
			}
			yield* Console.log(
				`fork advance-checkpoint: advanced ${parsedCount} checkpoint${parsedCount === 1 ? '' : 's'}` +
					(body.latestCheckpoint !== undefined ? `; latest=${body.latestCheckpoint}` : ''),
			);
		}),
).pipe(Command.withDescription('Seal pending txs into N new checkpoints (default 1)'));
