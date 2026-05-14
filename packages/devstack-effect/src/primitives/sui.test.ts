// Shape contracts for the RPC-only Sui factories. `suiLocalnet` is
// covered by the integration runs in `examples/wallet` — booting a real
// container under unit tests would just turn vitest red on machines
// without Docker. The localnet-with-external-rpcUrl branch is the same
// code path as `suiTestnet` minus the chain literal, so the assertions
// here also lock down its behavior implicitly.
//
// Each factory ultimately fetches `chainIdentifier` against its `rpcUrl`
// — we stub global `fetch` for the duration of the test so the assertion
// targets configuration logic, not network behavior.

import { Effect, Layer } from 'effect';
import { layer as NodeFileSystemLayer } from '@effect/platform-node/NodeFileSystem';
import { describe, expect, it } from '@effect/vitest';
import { EngineLive } from '../internal/engine.js';
import { EndpointRegistryLive } from '../internal/registries.js';
import { Sui } from '../interfaces/sui.js';
import { suiCustom, suiMainnet, suiTestnet } from './sui.js';

// EndpointRegistry is required by every Sui factory body (publish calls
// for `sui-rpc` / `sui-faucet` / `sui-graphql`). EngineLive backs the
// lifecycle wrap applied by `provideTag`.
const TestBaseLayer = Layer.mergeAll(EngineLive, NodeFileSystemLayer, EndpointRegistryLive);

// `SuiJsonRpcClient.getChainIdentifier` calls `getCheckpoint({id:'0'})`
// then base58-decodes `result.digest` and hex-encodes the first 4 bytes.
// Any valid base58 string of >=4 bytes makes the call resolve — pinning
// to a known checkpoint-zero-style digest keeps the stub realistic.
const STUB_CHECKPOINT_DIGEST = '4btiuiMPvEENsttpZC7CZ53DruC3MAgfznDbASZ7DR6S';

const stubChainIdFetch = (): (() => void) => {
	const original = globalThis.fetch;
	globalThis.fetch = (async () =>
		new Response(
			JSON.stringify({
				jsonrpc: '2.0',
				id: 1,
				result: {
					digest: STUB_CHECKPOINT_DIGEST,
					sequenceNumber: '0',
					epoch: '0',
					networkTotalTransactions: '0',
					timestampMs: '0',
					previousDigest: null,
					transactions: [],
					checkpointCommitments: [],
					validatorSignature: '',
				},
			}),
			{ status: 200, headers: { 'content-type': 'application/json' } },
		)) as typeof fetch;
	return () => {
		globalThis.fetch = original;
	};
};

describe('sui factory shapes', () => {
	it.effect('suiTestnet() defaults to the well-known testnet endpoints', () =>
		Effect.gen(function* () {
			const restore = stubChainIdFetch();
			try {
				const member = suiTestnet();
				const sui = yield* Effect.gen(function* () {
					return yield* Sui;
				}).pipe(Effect.provide(Layer.provide(member.__layer, TestBaseLayer)));
				expect(sui.network).toBe('testnet');
				expect(sui.rpcUrl).toBe('https://fullnode.testnet.sui.io:443');
				expect(sui.faucetUrl).toBe('https://faucet.testnet.sui.io');
			} finally {
				restore();
			}
		}),
	);

	it.effect('suiTestnet({ rpcUrl }) override wins over the default', () =>
		Effect.gen(function* () {
			const restore = stubChainIdFetch();
			try {
				const member = suiTestnet({ rpcUrl: 'https://corp.example/sui' });
				const sui = yield* Effect.gen(function* () {
					return yield* Sui;
				}).pipe(Effect.provide(Layer.provide(member.__layer, TestBaseLayer)));
				expect(sui.rpcUrl).toBe('https://corp.example/sui');
			} finally {
				restore();
			}
		}),
	);

	it.effect('suiMainnet() defaults to mainnet rpc with NO faucet', () =>
		Effect.gen(function* () {
			const restore = stubChainIdFetch();
			try {
				const member = suiMainnet();
				const sui = yield* Effect.gen(function* () {
					return yield* Sui;
				}).pipe(Effect.provide(Layer.provide(member.__layer, TestBaseLayer)));
				expect(sui.network).toBe('mainnet');
				expect(sui.rpcUrl).toBe('https://fullnode.mainnet.sui.io:443');
				// Mainnet has no faucet — confirming a misconfigured signer can't
				// silently ask mainnet for free tokens.
				expect(sui.faucetUrl).toBeUndefined();
			} finally {
				restore();
			}
		}),
	);

	it.effect('suiCustom({ network }) carries the caller label through to SuiShape', () =>
		Effect.gen(function* () {
			const restore = stubChainIdFetch();
			try {
				const member = suiCustom({ rpcUrl: 'https://forked.example/sui', network: 'devnet' });
				const sui = yield* Effect.gen(function* () {
					return yield* Sui;
				}).pipe(Effect.provide(Layer.provide(member.__layer, TestBaseLayer)));
				expect(sui.network).toBe('devnet');
				expect(sui.rpcUrl).toBe('https://forked.example/sui');
			} finally {
				restore();
			}
		}),
	);
});
