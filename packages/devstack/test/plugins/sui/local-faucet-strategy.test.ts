import { Effect } from 'effect';
import { describe, expect, it } from '@effect/vitest';

import { suiLocalStrategy } from '../../../src/plugins/sui/local-faucet-strategy.ts';
import {
	LeaseBrokerService,
	layerLeaseBroker,
} from '../../../src/substrate/runtime/lease-broker/index.ts';

describe('suiLocalStrategy', () => {
	it.effect('serializes concurrent requests when configured with a faucet lease', () =>
		Effect.gen(function* () {
			const broker = yield* LeaseBrokerService;
			const originalFetch = globalThis.fetch;
			const recipients: string[] = [];
			let active = 0;
			let maxActive = 0;

			globalThis.fetch = (async (_input, init) => {
				const body = JSON.parse(String(init?.body)) as {
					readonly FixedAmountRequest: { readonly recipient: string };
				};
				recipients.push(body.FixedAmountRequest.recipient);
				active += 1;
				maxActive = Math.max(maxActive, active);
				try {
					await new Promise((resolve) => setTimeout(resolve, 20));
					return new Response(JSON.stringify({ status: { Success: null } }), { status: 200 });
				} finally {
					active -= 1;
				}
			}) as typeof fetch;

			yield* Effect.gen(function* () {
				const strategy = suiLocalStrategy({
					faucetUrl: 'http://127.0.0.1:9123',
					serialization: {
						broker,
						key: 'sui-faucet:sui:localnet',
						owner: 'sui-faucet:sui:localnet',
					},
				});

				yield* Effect.all(
					[
						strategy.request({ address: '0x1', amount: 1n }),
						strategy.request({ address: '0x2', amount: 1n }),
					],
					{ concurrency: 'unbounded' },
				);

				expect(recipients).toEqual(['0x1', '0x2']);
				expect(maxActive).toBe(1);
			}).pipe(
				Effect.ensuring(
					Effect.sync(() => {
						globalThis.fetch = originalFetch;
					}),
				),
			);
		}).pipe(Effect.provide(layerLeaseBroker)),
	);
});
