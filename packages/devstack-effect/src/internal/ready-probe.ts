// Polls until a service is "ready" — used by the engine to gate dependents on a
// `started` signal that's stronger than "process spawned." Three probe kinds:
//
//   - `http`: GET `url`, accept on `status === expected` (default 200).
//   - `tcp`:  open a TCP socket; accept on `'connect'`.
//   - `log`:  consume a `Stream<string>` of log lines and accept on the first
//             line matching `match`.
//
// All three share the same retry / timeout machinery: poll every 200ms with
// exponential backoff (factor 1.5) capped at 2s, bounded by a hard total
// timeout (default 60s). Timeout surfaces as `ReadyProbeError`, never as
// Effect's built-in `Cause.TimeoutError`, so callers only see one tagged error.

import { Effect, Option, Schedule, Schema, Stream } from 'effect';
import * as net from 'node:net';

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

// Public-facing probe shapes. The user picks one of these on a plugin's
// `readyProbe` field. The engine (host-process / docker-container) wires the
// runtime `logs` stream onto a `log` probe before calling `awaitReady` —
// users never construct that field themselves.

export interface HttpReadyProbe {
	readonly kind: 'http';
	readonly url: string;
	readonly status?: number;
	readonly timeoutMs?: number;
}

export interface TcpReadyProbe {
	readonly kind: 'tcp';
	readonly host?: string;
	readonly port: number;
	readonly timeoutMs?: number;
}

export interface LogReadyProbe {
	readonly kind: 'log';
	readonly match: RegExp;
	readonly timeoutMs?: number;
}

export type ReadyProbe = HttpReadyProbe | TcpReadyProbe | LogReadyProbe;

// Engine-side variant: same shape as the public union, plus a `logs` stream on
// the `log` kind that the engine binds before invoking `awaitReady`. Internal
// only — callers should always pass `ReadyProbe` into the primitive API and
// let the engine widen it.
export type InternalLogReadyProbe = LogReadyProbe & {
	readonly logs?: Stream.Stream<string>;
};

export type InternalReadyProbe = HttpReadyProbe | TcpReadyProbe | InternalLogReadyProbe;

export class ReadyProbeError extends Schema.TaggedErrorClass<ReadyProbeError>()('ReadyProbeError', {
	probe: Schema.Unknown,
	message: Schema.String,
	// Optional last-response body / socket-error text captured during the
	// failing probe attempt. pretty-error.ts renders this so e.g. an HTTP
	// 503 with a meaningful error payload, or a TCP `ECONNREFUSED` cause,
	// surfaces in the failure tree without re-running.
	detail: Schema.optional(Schema.String),
	cause: Schema.optional(Schema.Defect),
}) {}

// -----------------------------------------------------------------------------
// Retry policy
// -----------------------------------------------------------------------------

// Exponential backoff starting at 200ms, factor 1.5, capped at 2s. `either`
// recurs when either schedule wants to recur and picks the *minimum* of the
// two delays, which is exactly the cap semantics we want: once exponential
// exceeds 2s, `spaced('2 seconds')` wins.
const retryPolicy = Schedule.exponential('200 millis', 1.5).pipe(
	Schedule.either(Schedule.spaced('2 seconds')),
);

// Default total time budget if the probe doesn't specify one. 60s matches the
// upstream devstack defaults and is generous enough for cold-start container
// images on a laptop.
const DEFAULT_TIMEOUT_MS = 60_000;

// Wrap a single-attempt probe with retry + total-timeout. Timeout converts
// `Cause.TimeoutError` into a `ReadyProbeError` so the surface is uniform.
const withRetryAndTimeout = (
	probe: InternalReadyProbe,
	attempt: Effect.Effect<void, ReadyProbeError>,
): Effect.Effect<void, ReadyProbeError> =>
	attempt.pipe(
		Effect.retry(retryPolicy),
		Effect.timeoutOrElse({
			duration: `${probe.timeoutMs ?? DEFAULT_TIMEOUT_MS} millis`,
			orElse: () =>
				Effect.fail(
					new ReadyProbeError({
						probe,
						message: 'timed out',
					}),
				),
		}),
	);

// -----------------------------------------------------------------------------
// HTTP probe
// -----------------------------------------------------------------------------

const httpAttempt = (probe: HttpReadyProbe): Effect.Effect<void, ReadyProbeError> =>
	Effect.gen(function* () {
		const expected = probe.status ?? 200;
		const response = yield* Effect.tryPromise({
			try: () => fetch(probe.url),
			catch: (cause) =>
				new ReadyProbeError({
					probe,
					message: 'fetch failed',
					detail: cause instanceof Error ? cause.message : String(cause),
					cause,
				}),
		});
		if (response.status !== expected) {
			// Best-effort: peek at the response body so a meaningful error
			// payload (e.g. HTML error page, JSON error envelope) surfaces
			// in the failure tree. Swallow body-read failures — the status
			// mismatch is the primary signal.
			const body = yield* Effect.tryPromise({
				try: () => response.text(),
				catch: () => undefined,
			}).pipe(Effect.catch(() => Effect.succeed<string | undefined>(undefined)));
			return yield* Effect.fail(
				new ReadyProbeError({
					probe,
					message: `status ${response.status} !== ${expected}`,
					detail: body !== undefined && body.length > 0 ? body : undefined,
				}),
			);
		}
	});

// -----------------------------------------------------------------------------
// TCP probe
// -----------------------------------------------------------------------------

const tcpAttempt = (probe: TcpReadyProbe): Effect.Effect<void, ReadyProbeError> =>
	Effect.callback<void, ReadyProbeError>((resume) => {
		const host = probe.host ?? 'localhost';
		const socket = net.createConnection({ host, port: probe.port });
		const onConnect = () => {
			socket.removeListener('error', onError);
			socket.end();
			resume(Effect.void);
		};
		const onError = (cause: Error) => {
			socket.removeListener('connect', onConnect);
			socket.destroy();
			resume(
				Effect.fail(
					new ReadyProbeError({
						probe,
						message: 'tcp connect failed',
						detail: cause.message,
						cause,
					}),
				),
			);
		};
		socket.once('connect', onConnect);
		socket.once('error', onError);
		// Interruption cleanup — drop the socket if the fiber is interrupted
		// mid-connect so we don't leak a half-open handle.
		return Effect.sync(() => {
			socket.removeListener('connect', onConnect);
			socket.removeListener('error', onError);
			socket.destroy();
		});
	});

// -----------------------------------------------------------------------------
// Log probe
// -----------------------------------------------------------------------------

// `Stream.find` doesn't exist in v4 — filter by predicate and pull the head.
// `runHead` returns `Option<string>`: `None` means the stream ended without a
// match (e.g. the process exited), which we treat as a probe failure so the
// retry policy gets a chance.
const logAttempt = (probe: InternalLogReadyProbe): Effect.Effect<void, ReadyProbeError> => {
	if (probe.logs === undefined) {
		return Effect.fail(
			new ReadyProbeError({
				probe,
				message: 'log probe requires a `logs` stream',
			}),
		);
	}
	const logs = probe.logs;
	return Effect.gen(function* () {
		// `Stream<string>` here is typed as error `never`, so `runHead` only
		// fails by completing without a match — handled below as None.
		const head = yield* Stream.runHead(Stream.filter(logs, (line) => probe.match.test(line)));
		if (Option.isNone(head)) {
			return yield* Effect.fail(
				new ReadyProbeError({
					probe,
					message: 'log stream ended without matching line',
				}),
			);
		}
	});
};

// -----------------------------------------------------------------------------
// Public API
// -----------------------------------------------------------------------------

export const awaitReady = (probe: InternalReadyProbe): Effect.Effect<void, ReadyProbeError> => {
	const attempt: Effect.Effect<void, ReadyProbeError> =
		probe.kind === 'http'
			? httpAttempt(probe)
			: probe.kind === 'tcp'
				? tcpAttempt(probe)
				: logAttempt(probe);
	return withRetryAndTimeout(probe, attempt).pipe(
		Effect.withSpan('ReadyProbe.awaitReady', {
			attributes: { 'probe.kind': probe.kind },
		}),
	);
};
