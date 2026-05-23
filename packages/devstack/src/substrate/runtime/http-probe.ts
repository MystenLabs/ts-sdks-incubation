import { Data, Effect } from 'effect';

import { ProbeTimeoutError, waitForProbe } from './probes.ts';

export type HttpProbeFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export type HttpProbeValidator = (response: Response) => boolean | Promise<boolean>;

export interface HttpProbeOptions {
	readonly endpoint: string | URL;
	readonly timeoutMs: number;
	readonly intervalMs?: number;
	readonly requestTimeoutMs?: number;
	readonly requestInit?: Omit<RequestInit, 'signal'>;
	readonly validate?: HttpProbeValidator;
	readonly fetch?: HttpProbeFetch;
}

export class HttpProbeError extends Data.TaggedError('HttpProbeError')<{
	readonly endpoint: string;
	readonly timeoutMs: number;
	readonly intervalMs: number;
	readonly requestTimeoutMs: number;
	readonly message: string;
	readonly lastStatus?: number;
	readonly lastError?: unknown;
}> {}

const DEFAULT_INTERVAL_MS = 250;

export const waitForHttpEndpoint = (
	options: HttpProbeOptions,
): Effect.Effect<void, HttpProbeError> =>
	Effect.gen(function* () {
		const endpoint = String(options.endpoint);
		const timeoutMs = options.timeoutMs;
		const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
		const requestTimeoutMs = options.requestTimeoutMs ?? intervalMs;
		const validate = options.validate ?? ((response: Response) => response.ok);
		const fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
		let lastStatus: number | undefined;

		return yield* waitForProbe({
			label: endpoint,
			timeoutMs,
			intervalMs,
			attemptTimeoutMs: requestTimeoutMs,
			probe: () =>
				Effect.tryPromise({
					try: (signal) =>
						fetchImpl(options.endpoint, {
							method: 'GET',
							...options.requestInit,
							signal,
						}),
					catch: (cause) => cause,
				}).pipe(
					Effect.flatMap((response) => {
						lastStatus = response.status;
						return Effect.tryPromise({
							try: () => Promise.resolve(validate(response)),
							catch: (cause) => cause,
						}).pipe(
							Effect.map((ready) =>
								ready ? true : { ready: false, detail: { status: response.status } },
							),
						);
					}),
				),
		}).pipe(
			Effect.mapError((cause) => {
				if (cause instanceof ProbeTimeoutError) {
					return new HttpProbeError({
						endpoint,
						timeoutMs,
						intervalMs,
						requestTimeoutMs,
						message: `HTTP endpoint ${endpoint} did not become ready within ${timeoutMs}ms`,
						...(lastStatus === undefined ? {} : { lastStatus }),
						...(cause.lastError === undefined ? {} : { lastError: cause.lastError }),
					});
				}
				return new HttpProbeError({
					endpoint,
					timeoutMs,
					intervalMs,
					requestTimeoutMs,
					message: `HTTP endpoint ${endpoint} probe failed`,
					...(lastStatus === undefined ? {} : { lastStatus }),
					lastError: cause,
				});
			}),
		);
	});
