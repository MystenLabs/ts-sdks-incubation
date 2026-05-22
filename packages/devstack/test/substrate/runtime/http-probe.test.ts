import { describe, expect, it } from '@effect/vitest';
import { Effect, Exit, Option } from 'effect';

import {
	HttpProbeError,
	waitForHttpEndpoint,
	type HttpProbeFetch,
} from '../../../src/substrate/runtime/http-probe.ts';

describe('HTTP readiness probe', () => {
	it('treats a successful HTTP response as ready by default', async () => {
		let calls = 0;
		const fetch: HttpProbeFetch = async () => {
			calls += 1;
			return new Response('ok', { status: 200 });
		};

		await Effect.runPromise(
			waitForHttpEndpoint({
				endpoint: 'http://127.0.0.1:8080/health',
				timeoutMs: 100,
				intervalMs: 1,
				fetch,
			}),
		);

		expect(calls).toBe(1);
	});

	it('lets callers parse the response before declaring readiness', async () => {
		let calls = 0;
		const fetch: HttpProbeFetch = async () => {
			calls += 1;
			return new Response(JSON.stringify({ status: calls < 3 ? 'starting' : 'up' }), {
				status: 200,
				headers: { 'content-type': 'application/json' },
			});
		};

		await Effect.runPromise(
			waitForHttpEndpoint({
				endpoint: 'http://127.0.0.1:8080/health',
				timeoutMs: 100,
				intervalMs: 1,
				fetch,
				validate: async (response) => {
					const body = (await response.json()) as { readonly status?: string };
					return body.status === 'up';
				},
			}),
		);

		expect(calls).toBe(3);
	});

	it('fails with the last observed HTTP status when the endpoint never validates', async () => {
		const fetch: HttpProbeFetch = async () => new Response('nope', { status: 503 });

		const exit = await Effect.runPromiseExit(
			waitForHttpEndpoint({
				endpoint: 'http://127.0.0.1:8080/health',
				timeoutMs: 1,
				intervalMs: 1,
				fetch,
			}),
		);

		expect(Exit.isFailure(exit)).toBe(true);
		const error = Exit.findErrorOption(exit);
		expect(Option.isSome(error)).toBe(true);
		if (Option.isSome(error)) {
			expect(error.value).toBeInstanceOf(HttpProbeError);
			expect(error.value).toMatchObject({
				endpoint: 'http://127.0.0.1:8080/health',
				timeoutMs: 1,
				intervalMs: 1,
				lastStatus: 503,
			});
		}
	});

	it('threads request options through repeated probes', async () => {
		let calls = 0;
		const fetch: HttpProbeFetch = async (_input, init) => {
			calls += 1;
			expect(init?.method).toBe('POST');
			expect(init?.headers).toEqual({ 'content-type': 'application/json' });
			expect(init?.body).toBe('{"ok":true}');
			return new Response('nope', { status: 503 });
		};

		const exit = await Effect.runPromiseExit(
			waitForHttpEndpoint({
				endpoint: 'http://127.0.0.1:8080/ready',
				timeoutMs: 2,
				intervalMs: 1,
				requestTimeoutMs: 1,
				requestInit: {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: '{"ok":true}',
				},
				fetch,
			}),
		);

		expect(calls).toBeGreaterThan(0);
		expect(Exit.isFailure(exit)).toBe(true);
		const error = Exit.findErrorOption(exit);
		expect(Option.isSome(error)).toBe(true);
		if (Option.isSome(error)) {
			expect(error.value).toMatchObject({
				endpoint: 'http://127.0.0.1:8080/ready',
				requestTimeoutMs: 1,
				lastStatus: 503,
			});
		}
	});

	it('records validator failures as the last probe error', async () => {
		const fetch: HttpProbeFetch = async () =>
			new Response(JSON.stringify({ status: { Failure: 'not funded' } }), { status: 200 });

		const exit = await Effect.runPromiseExit(
			waitForHttpEndpoint({
				endpoint: 'http://127.0.0.1:8080/v2/gas',
				timeoutMs: 2,
				intervalMs: 1,
				requestTimeoutMs: 1,
				fetch,
				validate: async (response) => {
					const body = (await response.json()) as { readonly status?: unknown };
					if (typeof body.status === 'object' && body.status !== null && 'Failure' in body.status) {
						throw new Error('body-level failure');
					}
					return true;
				},
			}),
		);

		expect(Exit.isFailure(exit)).toBe(true);
		const error = Exit.findErrorOption(exit);
		expect(Option.isSome(error)).toBe(true);
		if (Option.isSome(error)) {
			expect(error.value).toBeInstanceOf(HttpProbeError);
			expect(error.value.lastError).toBeInstanceOf(Error);
			expect((error.value.lastError as Error).message).toBe('body-level failure');
		}
	});
});
