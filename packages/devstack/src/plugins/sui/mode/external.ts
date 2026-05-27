// Sui plugin — local caller-owned RPC mode.
//
// Caller already has a Sui process running and supplies the RPC URL
// (optionally faucet and GraphQL). Used in CI, custom-runtime
// experiments, and "wrap my own sui localnet" scenarios.
//
// What's hard:
//   - The entire container + sidecar + build-container pipeline
//     must be skipped cleanly. No image build, no docker network,
//     no SuiBuildImage wired in.
//   - Downstream consumers must still get the same endpoint shape,
//     the same chain id, and a working `waitForTransactionsReady`
//     when a faucet URL is supplied.
//   - The chain-id fetch IS the only readiness sentinel; must have
//     a bounded timeout.
//
// Local-RPC mode contributes a `NetworkResolver` and a `ChainProbe`
// but does NOT contribute a `Snapshotable`-managed container or a
// `Routable` entrypoint (the caller's own router fronts the RPC).
//
// Boot sequence:
//
//   1. Construct an `@mysten/sui/grpc` `SuiGrpcClient` against the
//      caller-supplied `rpcUrl`. `network: 'localnet'` is the
//      semantically-correct discriminator — external IS a local-mode
//      sub-shape, not a public-net target.
//   2. Fetch the chain identifier with a bounded timeout — the only
//      readiness sentinel for this mode.
//   3. Build `waitForTransactionsReady`:
//        - If `faucetUrl` is supplied, wire the real HTTP probe
//          (same code path as local mode).
//        - Otherwise, the gate is a trivially-succeeding no-op
//          (callers that need funds must arrange them externally).
//   4. Assemble the resolved `SuiClient` and return it alongside the
//      `ResolvedSuiNetwork` projection (consumed by the codegen +
//      network-resolver contributions at the barrel).

import { Duration, Effect, type Scope } from 'effect';

import { SuiGrpcClient } from '@mysten/sui/grpc';

import { SpanAttr } from '../../../substrate/runtime/observability/spans.ts';
import { suiPluginError, type SuiPluginError } from '../errors.ts';
import { stringifyCause } from '../stringify-cause.ts';
import type { ResolvedSuiNetwork } from '../network-resolver.ts';
import { SuiSpans } from '../spans.ts';
import type { SuiClient } from './shared.ts';
import {
	assembleSuiClient,
	buildWaitForTransactionsReady,
	fetchChainId,
	makeResolvedNetwork,
	noopWaitForTransactionsReady,
} from './shared-boot.ts';
import type { SuiLocalRpcOptions } from './spec.ts';

/** Default chain-id fetch timeout for caller-owned local RPCs. The wire
 *  latency is the dominant cost; 30s is the documented ceiling. */
export const DEFAULT_EXTERNAL_CHAIN_ID_TIMEOUT = Duration.seconds(30);

/** Resolved local-RPC-mode boot artifacts. */
export interface LocalRpcModeBootResult {
	readonly resolved: ResolvedSuiNetwork;
	readonly client: SuiClient;
}

/** Build the local-RPC-mode boot Effect. No container, no sidecar,
 *  no build image. Just probe chain id + wire `waitForTransactionsReady`
 *  conditional on `faucetUrl`. */
export const bootLocalRpcMode = (
	opts: SuiLocalRpcOptions,
): Effect.Effect<LocalRpcModeBootResult, SuiPluginError, Scope.Scope> =>
	Effect.gen(function* () {
		// ----- 1. Construct the grpc client ----------------------------------
		// `network: 'localnet'` is semantically correct: external is a
		// substrate-level `'local'` sub-mode (caller's own localnet); the
		// SDK uses `network` for MVR / wallet-standard hints which the
		// caller-provided RPC won't honor anyway.
		const sdkClient = yield* Effect.try({
			try: () =>
				new SuiGrpcClient({
					baseUrl: opts.rpcUrl,
					network: 'localnet',
				}),
			catch: (cause): SuiPluginError =>
				suiPluginError(
					'chain-id-fetch',
					`sui local-rpc mode: SuiGrpcClient construction failed for rpcUrl=${opts.rpcUrl}: ${stringifyCause(cause)}`,
					cause,
				),
		});

		// ----- 2. Resolve chain id -------------------------------------------
		const chain =
			opts.chain ??
			(yield* fetchChainId(sdkClient, {
				timeout: opts.readyTimeout ?? DEFAULT_EXTERNAL_CHAIN_ID_TIMEOUT,
				span: 'devstack.plugin.sui.localRpc.fetchChainId',
			}));

		// ----- 3. Build waitForTransactionsReady -----------------------------
		// Faucet-bearing: real HTTP probe. Faucet-less: no-op (caller
		// must arrange funding out-of-band).
		const waitForTransactionsReady =
			opts.faucetUrl !== undefined
				? yield* buildWaitForTransactionsReady(opts.faucetUrl)
				: noopWaitForTransactionsReady;

		// ----- 4. Assemble + return ------------------------------------------
		const { client } = assembleSuiClient({
			sdkClient,
			chain,
			rpcUrl: opts.rpcUrl,
			...(opts.faucetUrl !== undefined ? { faucetUrl: opts.faucetUrl } : {}),
			...(opts.graphqlUrl !== undefined ? { graphqlUrl: opts.graphqlUrl } : {}),
			waitForTransactionsReady,
		});
		const resolved = makeResolvedNetwork({
			mode: 'local-rpc',
			chain,
			rpc: opts.rpcUrl,
			source: 'config',
			...(opts.faucetUrl !== undefined ? { faucet: opts.faucetUrl } : {}),
			...(opts.graphqlUrl !== undefined ? { graphql: opts.graphqlUrl } : {}),
		});

		return { resolved, client };
	}).pipe(
		Effect.withSpan('devstack.plugin.sui.localRpc.boot', {
			attributes: { [SpanAttr.plugin]: 'sui', [SuiSpans.mode]: 'local-rpc' },
		}),
	);

