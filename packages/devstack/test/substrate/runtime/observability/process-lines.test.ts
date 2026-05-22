import { describe, expect, it } from '@effect/vitest';
import { Deferred, Effect, Ref, Stream } from 'effect';

import { pluginKey } from '../../../../src/substrate/brand.ts';
import {
	observeProcessLines,
	splitUtf8Lines,
	type LoggerShape,
	type LogLevel,
} from '../../../../src/substrate/runtime/observability/index.ts';

const utf8 = new TextEncoder();

describe('process line observability', () => {
	it.effect('splits UTF-8 byte streams across chunk boundaries', () =>
		Effect.gen(function* () {
			const lines = yield* splitUtf8Lines(
				Stream.fromIterable([utf8.encode('one\nt'), utf8.encode('wo\nthree')]),
			).pipe(Stream.runCollect);

			expect(lines).toEqual(['one', 'two', 'three']);
		}),
	);

	it.effect('logs stdout and stderr lines with structured stream fields', () =>
		Effect.scoped(
			Effect.gen(function* () {
				const observed = yield* Ref.make<
					ReadonlyArray<{ readonly stream: 'stdout' | 'stderr'; readonly line: string }>
				>([]);
				const logged = yield* Ref.make<
					ReadonlyArray<{
						readonly level: LogLevel;
						readonly message: string;
						readonly fields: Readonly<Record<string, unknown>>;
					}>
				>([]);
				const ready = yield* Deferred.make<void>();

				const logger: LoggerShape = {
					log: (_tag, _key, payload) =>
						Effect.gen(function* () {
							yield* Ref.update(logged, (lines) => [
								...lines,
								{
									level: payload.level,
									message: payload.message,
									fields: payload.fields ?? {},
								},
							]);
						}),
					readTag: () => Effect.succeed({ lines: [], truncated: false }),
					readAll: Effect.succeed(new Map()),
					clearTag: () => Effect.void,
				};

				yield* observeProcessLines(
					{
						stdout: Stream.fromIterable([utf8.encode('ready\nnext')]),
						stderr: Stream.fromIterable([utf8.encode('warning\n')]),
					},
					{
						logger,
						tag: 'process/test',
						pluginKey: pluginKey('process-test#0'),
						fields: { serviceName: 'test-service' },
						onLine: (line) =>
							Effect.gen(function* () {
								const count = yield* Ref.updateAndGet(observed, (lines) => [...lines, line]);
								if (count.length === 3) {
									yield* Deferred.succeed(ready, undefined);
								}
							}),
					},
				);
				yield* Deferred.await(ready);

				expect(yield* Ref.get(observed)).toEqual([
					{ stream: 'stdout', line: 'ready' },
					{ stream: 'stdout', line: 'next' },
					{ stream: 'stderr', line: 'warning' },
				]);
				expect(yield* Ref.get(logged)).toEqual([
					{
						level: 'info',
						message: 'ready',
						fields: { serviceName: 'test-service', stream: 'stdout' },
					},
					{
						level: 'info',
						message: 'next',
						fields: { serviceName: 'test-service', stream: 'stdout' },
					},
					{
						level: 'warn',
						message: 'warning',
						fields: { serviceName: 'test-service', stream: 'stderr' },
					},
				]);
			}),
		),
	);
});
