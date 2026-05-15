// effect-app integration test. The script under test is a 6-line
// Effect program that:
//   1. yields the `Sui` interface tag
//   2. yields the `a.alice` account tag
//   3. logs `connected`, `chain id`, and `alice: <addr>`
//
// A real run boots a sui-localnet (~30 s cold). For unit coverage we
// instead provide stub layers for both tags and assert the program
// completes without error and emits the expected log lines. That gives
// us a smoke-test of the `provideDevstack`-style composition that
// `examples/effect-app` is meant to demonstrate without paying for a
// container boot.

import { Effect, Layer, Logger } from 'effect';
import { describe, expect, it } from 'vitest';
import { Sui } from '@mysten-incubation/devstack';
import { a, program } from './main.js';

// Minimal `Sui` stub — `client` is typed as `SuiJsonRpcClient` upstream
// but the program only reads `network` / `rpcUrl` / `chainId`, so an
// empty `{}` cast satisfies the interface for testing.
const STUB_SUI_SHAPE = {
	network: 'localnet' as const,
	rpcUrl: 'http://localhost:9000',
	chainId: 'aabbccdd',
	client: {} as never,
};

const STUB_ALICE_ADDRESS = '0x000000000000000000000000000000000000000000000000000000000000a11ce';
const STUB_ALICE_SHAPE = {
	name: 'alice',
	address: STUB_ALICE_ADDRESS,
	scheme: 'ed25519' as const,
	publicKey: new Uint8Array(32),
	signAndExecute: () =>
		Effect.die('signAndExecute stub not called by the smoke test'),
	signTransaction: () => Effect.die('signTransaction stub not called'),
	signPersonalMessage: () => Effect.die('signPersonalMessage stub not called'),
};

describe('effect-app program', () => {
	it('resolves Sui + alice tags and logs the expected lines', async () => {
		const captured: Array<string> = [];
		const captureLogger = Logger.make<unknown, void>(({ message }) => {
			if (Array.isArray(message)) captured.push(message.join(' '));
			else captured.push(String(message));
		});

		const stubLayer = Layer.mergeAll(
			Layer.succeed(Sui, STUB_SUI_SHAPE),
			Layer.succeed(a.alice, STUB_ALICE_SHAPE),
			Logger.layer([captureLogger]),
		);

		await Effect.runPromise(program.pipe(Effect.provide(stubLayer)));

		const joined = captured.join('\n');
		expect(joined).toContain('connected to sui localnet at http://localhost:9000');
		expect(joined).toContain('chain id: aabbccdd');
		expect(joined).toContain(`alice: ${STUB_ALICE_ADDRESS}`);
	});
});
