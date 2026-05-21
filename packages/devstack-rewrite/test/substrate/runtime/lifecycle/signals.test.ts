import { Effect, Queue } from 'effect';
import { describe, expect, it } from 'vitest';

import type { EngineCommand } from '../../../../src/substrate/events.ts';
import { installSignalHandler } from '../../../../src/substrate/runtime/lifecycle/signals.ts';

describe('installSignalHandler', () => {
	it('routes the first SIGINT through the supervisor command queue', async () => {
		const previousExitCode = process.exitCode;
		const listenerCount = process.listenerCount('SIGINT');

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

			expect(process.listenerCount('SIGINT')).toBe(listenerCount);
		} finally {
			process.exitCode = previousExitCode;
		}
	});
});
