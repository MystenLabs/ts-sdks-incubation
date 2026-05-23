import { Effect, Stream } from 'effect';
import type { Scope } from 'effect';

import type { PluginKey } from '../../brand.ts';
import type { LoggerShape, LogLevel } from './logger.ts';

export type ProcessOutputStream = 'stdout' | 'stderr';

export interface ObservedProcessLine {
	readonly stream: ProcessOutputStream;
	readonly line: string;
}

export interface ObserveProcessLinesOptions {
	readonly logger: LoggerShape;
	readonly tag: string;
	readonly pluginKey: PluginKey | null;
	readonly fields?: Readonly<Record<string, unknown>>;
	readonly onLine?: (line: ObservedProcessLine) => Effect.Effect<void>;
	readonly levelForStream?: (stream: ProcessOutputStream) => LogLevel;
}

export type ProcessByteStream<E = unknown, R = never> = Stream.Stream<Uint8Array, E, R>;

export const splitUtf8Lines = <E, R>(
	stream: ProcessByteStream<E, R>,
): Stream.Stream<string, E, R> => stream.pipe(Stream.decodeText(), Stream.splitLines);

export const readableToByteStream = (
	stream: AsyncIterable<Uint8Array> | null | undefined,
	mapError: (cause: unknown) => unknown = (cause) => cause,
): ProcessByteStream => {
	if (stream === null || stream === undefined) return Stream.empty;
	return Stream.fromAsyncIterable(stream, mapError);
};

const defaultLevelForStream = (stream: ProcessOutputStream): LogLevel =>
	stream === 'stderr' ? 'warn' : 'info';

const drainLineStream = (
	stream: ProcessByteStream,
	streamName: ProcessOutputStream,
	options: ObserveProcessLinesOptions,
): Effect.Effect<void, never> => {
	const levelForStream = options.levelForStream ?? defaultLevelForStream;
	const fields = options.fields ?? {};
	const drain = splitUtf8Lines(stream).pipe(
		Stream.tap((line) =>
			Effect.gen(function* () {
				yield* options.logger
					.log(options.tag, options.pluginKey, {
						level: levelForStream(streamName),
						message: line,
						fields: { ...fields, stream: streamName },
					})
					.pipe(Effect.ignore);
				if (options.onLine !== undefined) {
					yield* options.onLine({ stream: streamName, line }).pipe(Effect.ignore);
				}
			}),
		),
		Stream.runDrain,
		Effect.ignore,
	);
	return drain;
};

export const observeProcessLines = (
	streams: {
		readonly stdout?: ProcessByteStream | null;
		readonly stderr?: ProcessByteStream | null;
	},
	options: ObserveProcessLinesOptions,
): Effect.Effect<void, never, Scope.Scope> =>
	Effect.gen(function* () {
		if (streams.stdout !== undefined && streams.stdout !== null) {
			yield* drainLineStream(streams.stdout, 'stdout', options).pipe(Effect.forkScoped);
		}
		if (streams.stderr !== undefined && streams.stderr !== null) {
			yield* drainLineStream(streams.stderr, 'stderr', options).pipe(Effect.forkScoped);
		}
	});
