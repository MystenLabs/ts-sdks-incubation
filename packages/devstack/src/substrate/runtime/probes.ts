import { Data, Duration, Effect, Types } from 'effect';

export type ProbeAttemptResult =
	| void
	| boolean
	| {
			readonly ready: boolean;
			readonly detail?: unknown;
	  };

export interface ProbeOptions<E = unknown, R = never> {
	readonly label: string;
	readonly timeoutMs: number;
	readonly intervalMs?: number;
	readonly attemptTimeoutMs?: number;
	readonly probe: () => Effect.Effect<ProbeAttemptResult, E, R>;
	readonly isRetryableError?: (error: E) => boolean;
}

export class ProbeAttemptTimeoutError extends Data.TaggedError('ProbeAttemptTimeoutError')<{
	readonly label: string;
	readonly attemptTimeoutMs: number;
	readonly message: string;
}> {}

export class ProbeTimeoutError extends Data.TaggedError('ProbeTimeoutError')<{
	readonly label: string;
	readonly timeoutMs: number;
	readonly intervalMs: number;
	readonly attemptTimeoutMs?: number;
	readonly attempts: number;
	readonly message: string;
	readonly lastError?: unknown;
	readonly lastNotReady?: unknown;
}> {}

const DEFAULT_INTERVAL_MS = 250;

const normalizeAttempt = (
	result: ProbeAttemptResult,
): { readonly ready: boolean; readonly detail?: unknown } => {
	if (result === undefined || result === true) return { ready: true };
	if (result === false) return { ready: false };
	return result;
};

const withAttemptTimeout = <A, E, R>(
	effect: Effect.Effect<A, E, R>,
	options: {
		readonly label: string;
		readonly attemptTimeoutMs?: number;
		readonly remainingMs: number;
	},
): Effect.Effect<A, E | ProbeAttemptTimeoutError, R> => {
	if (options.attemptTimeoutMs === undefined) return effect;
	const timeoutMs = Math.max(1, Math.min(options.attemptTimeoutMs, options.remainingMs));
	return effect.pipe(
		Effect.timeoutOrElse({
			duration: Duration.millis(timeoutMs),
			orElse: () =>
				Effect.fail(
					new ProbeAttemptTimeoutError({
						label: options.label,
						attemptTimeoutMs: timeoutMs,
						message: `Probe ${options.label} attempt did not complete within ${timeoutMs}ms`,
					}),
				),
		}),
	);
};

export const waitForProbe = <E, R = never>(
	options: ProbeOptions<E, R>,
): Effect.Effect<void, E | ProbeTimeoutError, R> =>
	Effect.gen(function* () {
		const timeoutMs = options.timeoutMs;
		const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
		const started = Date.now();
		const deadline = started + timeoutMs;
		let attempts = 0;
		let lastError: unknown;
		let lastNotReady: unknown;

		for (;;) {
			const remainingMs = deadline - Date.now();
			if (remainingMs <= 0) {
				return yield* Effect.fail(
					new ProbeTimeoutError({
						label: options.label,
						timeoutMs,
						intervalMs,
						...(options.attemptTimeoutMs === undefined
							? {}
							: { attemptTimeoutMs: options.attemptTimeoutMs }),
						attempts,
						message: `Probe ${options.label} did not become ready within ${timeoutMs}ms`,
						...(lastError === undefined ? {} : { lastError }),
						...(lastNotReady === undefined ? {} : { lastNotReady }),
					}),
				);
			}

			attempts += 1;
			const ready = yield* withAttemptTimeout(options.probe(), {
				label: options.label,
				attemptTimeoutMs: options.attemptTimeoutMs,
				remainingMs,
			}).pipe(
				Effect.matchEffect({
					onFailure: (error) => {
						if (
							!(error instanceof ProbeAttemptTimeoutError) &&
							options.isRetryableError?.(error as E) === false
						) {
							return Effect.fail(error as E);
						}
						lastError = error;
						return Effect.succeed(false);
					},
					onSuccess: (result) => {
						const normalized = normalizeAttempt(result);
						if (!normalized.ready) lastNotReady = normalized.detail ?? false;
						return Effect.succeed(normalized.ready);
					},
				}),
			);
			if (ready) return;

			const sleepMs = Math.min(intervalMs, Math.max(1, deadline - Date.now()));
			yield* Effect.sleep(Duration.millis(sleepMs));
		}
	});

export interface ExitCodeProbeResult {
	readonly exitCode: number;
	readonly stdout?: string;
	readonly stderr?: string;
}

export const exitCodeProbeResult = (result: ExitCodeProbeResult): ProbeAttemptResult => {
	if (result.exitCode === 0) return true;
	return {
		ready: false,
		detail: {
			exitCode: result.exitCode,
			...(result.stdout === undefined ? {} : { stdout: result.stdout }),
			...(result.stderr === undefined ? {} : { stderr: result.stderr }),
		},
	};
};

// ---------------------------------------------------------------------------
// probeManyLenient — run a set of lenient `T | null` probes and surface
// each probe's verdict so the caller can fold the array however it likes.
// ---------------------------------------------------------------------------
//
// Lenient probes (per `ChainProbe`'s `'lenient'` contract) return `T | null`
// where `null` is a non-authoritative "not yet" signal. Several plugins
// (walrus deploy, deepbook deploy, pyth init) hand-roll a sequential loop
// that early-returns `null` on the first non-ready probe. This helper
// centralizes the iteration so the call sites collapse to a `.every()`
// or `.find()` against the returned array.
//
// Concurrency defaults to `'unbounded'`. Callers that need sequential
// short-circuit semantics (e.g. RPC backoff politeness) can pass
// `concurrency: 1`. The return shape is the full array even when concurrency
// is 1 — callers that want "any null aborts and returns null" should fold
// with `.every((x) => x !== null) ? array : null` themselves.

export const probeManyLenient = <T, E, R>(
	probes: ReadonlyArray<Effect.Effect<T | null, E, R>>,
	options?: { readonly concurrency?: Types.Concurrency },
): Effect.Effect<ReadonlyArray<T | null>, E, R> =>
	Effect.forEach(probes, (probe) => probe, {
		concurrency: options?.concurrency ?? 'unbounded',
	});
