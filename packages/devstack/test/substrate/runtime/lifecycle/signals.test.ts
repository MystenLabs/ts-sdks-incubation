import { Effect, Queue } from 'effect';
import { describe, expect, it } from 'vitest';

import type { EngineCommand } from '../../../../src/substrate/events.ts';
import {
	handledSignals,
	installSignalHandler,
} from '../../../../src/substrate/runtime/lifecycle/signals.ts';

const listenerCounts = (): ReadonlyMap<string, number> =>
	new Map(handledSignals.map((signal) => [signal, process.listenerCount(signal)]));

const expectListenerCounts = (counts: ReadonlyMap<string, number>): void => {
	for (const signal of handledSignals) {
		expect(process.listenerCount(signal)).toBe(counts.get(signal));
	}
};

describe('installSignalHandler', () => {
	it('routes the first SIGINT through the supervisor command queue', async () => {
		const previousExitCode = process.exitCode;
		const counts = listenerCounts();

		try {
			process.exitCode = undefined;
			await Effect.runPromise(
				Effect.scoped(
					Effect.gen(function* () {
						const commands = yield* Queue.unbounded<EngineCommand>();
						yield* Effect.forkScoped(installSignalHandler(commands));
						yield* Effect.yieldNow;

						process.emit('SIGINT');

						const command = yield* Queue.take(commands);
						expect(command).toEqual({ tag: 'shutdown.requested' });
						expect(process.exitCode).toBe(130);
					}),
				),
			);

			expectListenerCounts(counts);
		} finally {
			process.exitCode = previousExitCode;
		}
	});

	it('routes the second handled signal as hard-kill before scheduling exit', async () => {
		const previousExitCode = process.exitCode;
		const counts = listenerCounts();
		const scheduledExits: number[] = [];

		try {
			process.exitCode = undefined;
			await Effect.runPromise(
				Effect.scoped(
					Effect.gen(function* () {
						const commands = yield* Queue.bounded<EngineCommand>(1);
						yield* Effect.forkScoped(
							installSignalHandler(commands, {
								scheduleExit: (exitCode) => {
									scheduledExits.push(exitCode);
								},
							}),
						);
						yield* Effect.yieldNow;

						process.emit('SIGINT');
						for (let i = 0; i < 10; i++) {
							if (yield* Queue.isFull(commands)) break;
							yield* Effect.yieldNow;
						}
						expect(yield* Queue.isFull(commands)).toBe(true);

						process.emit('SIGTERM');
						yield* Effect.yieldNow;
						expect(scheduledExits).toEqual([]);

						const graceful = yield* Queue.take(commands);
						expect(graceful).toEqual({ tag: 'shutdown.requested' });

						const hardKill = yield* Queue.take(commands);
						expect(hardKill).toMatchObject({
							tag: 'shutdown.hardKillRequested',
							signal: 'SIGTERM',
							exitCode: 143,
						});
						expect(hardKill).toHaveProperty('at');
						for (let i = 0; i < 10; i++) {
							if (scheduledExits.length > 0) break;
							yield* Effect.yieldNow;
						}
						expect(scheduledExits).toEqual([143]);
						expect(process.exitCode).toBe(130);
					}),
				),
			);

			expectListenerCounts(counts);
		} finally {
			process.exitCode = previousExitCode;
		}
	});
});
