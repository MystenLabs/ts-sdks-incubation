import { Effect, Schema } from 'effect';
import { describe, expect, it } from '@effect/vitest';

import type {
	ChainProbe,
	ChainProbeError,
	ChainProbeMode,
	ChainProbeSchema,
} from '../../../src/contracts/chain-probe.ts';
import { buildVerifyProbe } from '../../../src/plugins/package/mode-local.ts';
import type { SuiProbeKey } from '../../../src/plugins/sui/chain-probe.ts';

const transientProbe = (
	values: ReadonlyArray<{ readonly objectId: string; readonly type: unknown } | null>,
): ChainProbe<SuiProbeKey> => {
	let calls = 0;
	return {
		get: <Shape>(_key: SuiProbeKey, schema: ChainProbeSchema<Shape>, _mode: ChainProbeMode) =>
			Effect.sync(() => {
				const value = values[Math.min(calls, values.length - 1)] ?? null;
				calls += 1;
				return value;
			}).pipe(
				Effect.flatMap((value) =>
					value === null
						? Effect.succeed(null)
						: Schema.decodeUnknownEffect(schema)(value).pipe(
								Effect.mapError(
									(cause): ChainProbeError => ({
										_tag: 'ChainProbeError',
										reason: 'decode-failed',
										chain: 'sui:localnet',
										detail: String(cause),
									}),
								),
							),
				),
			),
	};
};

describe('local package mode', () => {
	it.effect('retries cached package verification before treating a hit as stale', () =>
		Effect.gen(function* () {
			const probe = transientProbe([null, null, { objectId: '0xpkg', type: 'package' }]);

			const verified = yield* buildVerifyProbe(probe, '0xpkg', {
				maxAttempts: 3,
				delayMs: 0,
			});

			expect(verified).toEqual({ objectId: '0xpkg', type: 'package' });
		}),
	);

	it.effect('returns null after cached package verification is exhausted', () =>
		Effect.gen(function* () {
			let calls = 0;
			const probe: ChainProbe<SuiProbeKey> = {
				get: () =>
					Effect.sync(() => {
						calls += 1;
						return null;
					}),
			};

			const verified = yield* buildVerifyProbe(probe, '0xmissing', {
				maxAttempts: 3,
				delayMs: 0,
			});

			expect(verified).toBeNull();
			expect(calls).toBe(3);
		}),
	);

	it.effect('treats decode failures as stale cache after the retry budget', () =>
		Effect.gen(function* () {
			let calls = 0;
			const probe: ChainProbe<SuiProbeKey> = {
				get: () =>
					Effect.fail({
						_tag: 'ChainProbeError',
						reason: 'decode-failed',
						chain: 'sui:localnet',
						detail: 'bad shape',
					} satisfies ChainProbeError).pipe(
						Effect.tapError(() =>
							Effect.sync(() => {
								calls += 1;
							}),
						),
					),
			};

			const verified = yield* buildVerifyProbe(probe, '0xbad', {
				maxAttempts: 2,
				delayMs: 0,
			});

			expect(verified).toBeNull();
			expect(calls).toBe(2);
		}),
	);
});
