import { describe, expect, it } from '@effect/vitest';
import { Effect, Exit, Option } from 'effect';

import {
	ProbeTimeoutError,
	exitCodeProbeResult,
	waitForProbe,
} from '../../../src/substrate/runtime/probes.ts';

describe('waitForProbe', () => {
	it('retries not-ready results until a probe succeeds', async () => {
		let attempts = 0;

		await Effect.runPromise(
			waitForProbe({
				label: 'eventual',
				timeoutMs: 100,
				intervalMs: 1,
				probe: () =>
					Effect.sync(() => {
						attempts += 1;
						return attempts >= 3;
					}),
			}),
		);

		expect(attempts).toBe(3);
	});

	it('captures the last non-ready detail on timeout', async () => {
		const exit = await Effect.runPromiseExit(
			waitForProbe({
				label: 'never-ready',
				timeoutMs: 2,
				intervalMs: 1,
				probe: () => Effect.succeed({ ready: false, detail: { status: 503 } }),
			}),
		);

		expect(Exit.isFailure(exit)).toBe(true);
		const error = Exit.findErrorOption(exit);
		expect(Option.isSome(error)).toBe(true);
		if (Option.isSome(error)) {
			expect(error.value).toBeInstanceOf(ProbeTimeoutError);
			expect(error.value).toMatchObject({
				label: 'never-ready',
				timeoutMs: 2,
				lastNotReady: { status: 503 },
			});
		}
	});

	it('lets callers mark probe errors as fatal', async () => {
		const fatal = new Error('fatal');
		const exit = await Effect.runPromiseExit(
			waitForProbe({
				label: 'fatal',
				timeoutMs: 100,
				intervalMs: 1,
				isRetryableError: () => false,
				probe: () => Effect.fail(fatal),
			}),
		);

		const error = Exit.findErrorOption(exit);
		expect(Option.isSome(error)).toBe(true);
		if (Option.isSome(error)) {
			expect(error.value).toBe(fatal);
		}
	});
});

describe('exitCodeProbeResult', () => {
	it('maps exit code zero to ready and non-zero to not-ready detail', () => {
		expect(exitCodeProbeResult({ exitCode: 0 })).toBe(true);
		expect(exitCodeProbeResult({ exitCode: 1, stderr: 'starting' })).toEqual({
			ready: false,
			detail: { exitCode: 1, stderr: 'starting' },
		});
	});
});
