// Sui plugin — live mode (testnet / mainnet / devnet / custom).
//
// Wraps a public or caller-provided Sui RPC. Testnet has a faucet;
// mainnet has none; custom may or may not.
//
// What's hard:
//   - No ready probe is meaningful (the public chain is always
//     up); chain-id fetch IS the only sentinel with a bounded
//     timeout.
//   - Faucet-less networks (mainnet) need a "no-op" funds-ready
//     gate so downstream callers don't have to branch.
//   - The KnownPackage substrate contributions are wired here so
//     wallet-standard / MVR / known-deployment lookups find the
//     right published ids.
//
// Live mode contributes a `NetworkResolver`, a `ChainProbe`, and a
// `Codegenable` — but NO managed container, NO `Routable`, and the
// build container is forced to the host CLI path (no in-stack
// build image). The latter is flagged in the distilled-doc Open
// questions as a candidate to revisit.
//
// Boot sequence:
//
//   1. Resolve `rpcUrl` / `faucetUrl` / `graphqlUrl` from caller
//      overrides, then fall back to `LIVE_DEFAULTS` for known nets.
//      `custom` requires `rpcUrl` — surface a typed refusal if
//      omitted.
//   2. Construct `SuiGrpcClient` against the resolved URL with the
//      matching `network:` discriminator (so MVR / wallet-standard
//      hints route correctly).
//   3. Fetch chain id (the only readiness sentinel for live).
//   4. Build `waitForTransactionsReady`:
//        - mainnet: trivially-succeeding no-op (no faucet exists).
//        - testnet/devnet/custom-with-faucet: real HTTP probe.
//        - custom-without-faucet: no-op.

import { Duration, Effect, type Scope } from 'effect';

import { SuiGrpcClient } from '@mysten/sui/grpc';

import { suiPluginError, type SuiPluginError } from '../errors.ts';
import type { ResolvedSuiNetwork } from '../network-resolver.ts';
import type { SuiClient } from './shared.ts';
import {
	assembleSuiClient,
	buildWaitForTransactionsReady,
	fetchChainId,
	makeResolvedNetwork,
	noopWaitForTransactionsReady,
} from './shared-boot.ts';
import type { SuiLiveOptions } from './spec.ts';

/** Default chain-id fetch timeout for live RPCs. */
export const DEFAULT_LIVE_CHAIN_ID_TIMEOUT = Duration.seconds(30);

/** Default RPC endpoints per known network. `custom` requires the
 *  caller to supply `rpcUrl`. */
export const LIVE_DEFAULTS = {
	testnet: {
		rpcUrl: 'https://fullnode.testnet.sui.io:443',
		faucetUrl: 'https://faucet.testnet.sui.io',
		graphqlUrl: 'https://sui-testnet.mystenlabs.com/graphql',
	},
	mainnet: {
		rpcUrl: 'https://fullnode.mainnet.sui.io:443',
		faucetUrl: undefined as string | undefined,
		graphqlUrl: 'https://sui-mainnet.mystenlabs.com/graphql',
	},
	devnet: {
		rpcUrl: 'https://fullnode.devnet.sui.io:443',
		faucetUrl: 'https://faucet.devnet.sui.io',
		graphqlUrl: undefined as string | undefined,
	},
} as const;

/** Resolved live-mode boot artifacts. */
export interface LiveModeBootResult {
	readonly resolved: ResolvedSuiNetwork;
	readonly client: SuiClient;
}

interface ResolvedLiveEndpoints {
	readonly rpcUrl: string;
	readonly faucetUrl: string | undefined;
	readonly graphqlUrl: string | undefined;
	readonly sdkNetwork: 'mainnet' | 'testnet' | 'devnet' | 'localnet';
}

/** Resolve endpoints from caller overrides + the known-network table.
 *  Order: caller-provided wins; otherwise the LIVE_DEFAULTS row for
 *  the requested network. `custom` MUST carry an explicit `rpcUrl`. */
const resolveEndpoints = (
	opts: SuiLiveOptions,
): Effect.Effect<ResolvedLiveEndpoints, SuiPluginError> => {
	if (opts.network === 'custom') {
		if (opts.rpcUrl === undefined) {
			return Effect.fail(
				suiPluginError(
					'chain-id-fetch',
					`sui live mode: network='custom' requires opts.rpcUrl. ` +
						`Use suiFor(network).live.custom({rpcUrl: ...}) or pass network='testnet'|'mainnet'|'devnet' to use the built-in defaults.`,
				),
			);
		}
		return Effect.succeed({
			rpcUrl: opts.rpcUrl,
			faucetUrl: opts.faucetUrl,
			graphqlUrl: opts.graphqlUrl,
			// SDK accepts arbitrary strings under the `(string & {})`
			// branch; `localnet` is the closest semantic for a custom
			// caller-defined live target.
			sdkNetwork: 'localnet',
		});
	}
	const defaults = LIVE_DEFAULTS[opts.network];
	return Effect.succeed({
		rpcUrl: opts.rpcUrl ?? defaults.rpcUrl,
		faucetUrl: opts.faucetUrl ?? defaults.faucetUrl,
		graphqlUrl: opts.graphqlUrl ?? defaults.graphqlUrl,
		sdkNetwork: opts.network,
	});
};

/** Build the live-mode boot Effect. */
export const bootLiveMode = (
	opts: SuiLiveOptions,
): Effect.Effect<LiveModeBootResult, SuiPluginError, Scope.Scope> =>
	Effect.gen(function* () {
		// ----- 1. Resolve endpoints ------------------------------------------
		const endpoints = yield* resolveEndpoints(opts);

		yield* Effect.annotateCurrentSpan({
			'sui.live.network': opts.network,
			'sui.live.rpcUrl': endpoints.rpcUrl,
			'sui.live.faucetUrl': endpoints.faucetUrl ?? '<none>',
		});

		// ----- 2. Construct the grpc client ----------------------------------
		const sdkClient = yield* Effect.try({
			try: () =>
				new SuiGrpcClient({
					baseUrl: endpoints.rpcUrl,
					network: endpoints.sdkNetwork,
				}),
			catch: (cause): SuiPluginError =>
				suiPluginError(
					'chain-id-fetch',
					`sui live mode: SuiGrpcClient construction failed for rpcUrl=${endpoints.rpcUrl}: ${stringifyCause(cause)}`,
					cause,
				),
		});

		// ----- 3. Resolve chain id -------------------------------------------
		const chain =
			opts.chain ??
			(yield* fetchChainId(sdkClient, {
				timeout: opts.readyTimeout ?? DEFAULT_LIVE_CHAIN_ID_TIMEOUT,
				span: 'devstack.plugin.sui.live.fetchChainId',
			}));

		// ----- 4. Build waitForTransactionsReady -----------------------------
		// Mainnet: no faucet exists, gate is a no-op. testnet/devnet/
		// custom-with-faucet: real HTTP probe (rate-limited by upstream,
		// but the wire shape is identical to localnet).
		const waitForTransactionsReady =
			endpoints.faucetUrl !== undefined
				? yield* buildWaitForTransactionsReady(endpoints.faucetUrl)
				: noopWaitForTransactionsReady;

		// ----- 5. Assemble + return ------------------------------------------
		const { client } = assembleSuiClient({
			sdkClient,
			chain,
			rpcUrl: endpoints.rpcUrl,
			...(endpoints.faucetUrl !== undefined ? { faucetUrl: endpoints.faucetUrl } : {}),
			...(endpoints.graphqlUrl !== undefined ? { graphqlUrl: endpoints.graphqlUrl } : {}),
			waitForTransactionsReady,
		});
		const resolved = makeResolvedNetwork({
			mode: 'live',
			chain,
			rpc: endpoints.rpcUrl,
			// `source: 'default'` when we pulled from LIVE_DEFAULTS;
			// `'config'` when the caller passed an override. The
			// distinction matters for the doctor's "where did this
			// value come from" surface.
			source:
				opts.rpcUrl === undefined && opts.faucetUrl === undefined && opts.graphqlUrl === undefined
					? 'default'
					: 'config',
			...(endpoints.faucetUrl !== undefined ? { faucet: endpoints.faucetUrl } : {}),
			...(endpoints.graphqlUrl !== undefined ? { graphql: endpoints.graphqlUrl } : {}),
		});

		return { resolved, client };
	}).pipe(
		Effect.withSpan('devstack.plugin.sui.live.boot', {
			attributes: { 'devstack.plugin': 'sui', 'sui.mode': 'live' },
		}),
	);

const stringifyCause = (cause: unknown): string => {
	if (cause instanceof Error) return cause.message;
	if (typeof cause === 'string') return cause;
	try {
		return JSON.stringify(cause);
	} catch {
		return String(cause);
	}
};
