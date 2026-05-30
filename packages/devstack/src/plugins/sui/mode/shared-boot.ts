// Sui plugin — boot helpers shared across local / external / live modes.
//
// What lives here (and why):
//
//   - `fetchChainId(client, opts?)` — bounded chain-id probe. The
//     only readiness sentinel for external + live; local treats it
//     as the chain-id capture step after the multi-probe gate has
//     succeeded.
//   - `buildWaitForTransactionsReady(faucetUrl, opts?)` — memoised
//     funds-ready gate for faucet-bearing networks. `Effect.cached`
//     with a manual-invalidation surface (the distilled-doc
//     opportunity called out in `mode/shared.ts`).
//   - `noopWaitForTransactionsReady` — trivially-succeeding gate for
//     faucet-less networks (live mainnet, fork).
//   - `assembleSuiClient(...)` — collapses the boilerplate that
//     local/local-rpc/live all repeat (sdk shim + chainProbe + the
//     `fork: null` discriminator).
//
// Why not jam this into `mode/local.ts`: external + live can't
// import from `local.ts` without dragging the container-runtime
// import path along; the helpers below are wire-only and have NO
// substrate-context dependencies.

import { Duration, Effect, SynchronizedRef, type Scope } from 'effect';

import type { SuiGrpcClient } from '@mysten/sui/grpc';

import type { ChainProbe } from '../../../contracts/chain-probe.ts';
import { chainId as brandChainId } from '../../../substrate/brand.ts';
import { waitForHttpEndpoint } from '../../../substrate/runtime/http-probe.ts';
import { makeSuiChainProbe, type SuiSdkShim, type SuiProbeKey } from '../chain-probe.ts';
import { suiConfigError, suiPluginError, type SuiConfigError, type SuiPluginError } from '../errors.ts';
import { formatUnknownError } from '../../../substrate/runtime/format-unknown-error.ts';
import type { ResolvedSuiNetwork } from '../network-resolver.ts';
import { SuiSpans } from '../spans.ts';
import { toDockerHostGatewayUrl, type SuiClient, type WaitForTransactionsReady } from './shared.ts';

// ---------------------------------------------------------------------------
// Chain-id fetch — bounded, typed-error
// ---------------------------------------------------------------------------

/** Default chain-id fetch timeout. The wire latency is the dominant
 *  cost on real RPCs; 30 s is the documented ceiling. */
export const DEFAULT_CHAIN_ID_TIMEOUT = Duration.seconds(30);

/** Fetch the chain identifier off a constructed grpc client. The
 *  result is the bare string that downstream cache layers fold into
 *  their state-store keys. */
export const fetchChainId = (
	sdkClient: SuiGrpcClient,
	opts?: { readonly timeout?: Duration.Duration; readonly span?: string },
): Effect.Effect<string, SuiPluginError> => {
	const timeout = opts?.timeout ?? DEFAULT_CHAIN_ID_TIMEOUT;
	const timeoutMs = Duration.toMillis(timeout);
	return Effect.tryPromise({
		try: (signal) =>
			sdkClient.ledgerService
				.getServiceInfo({}, { abort: signal, timeout: timeoutMs })
				.response.then((response) => {
					if (!response.chainId) {
						throw new Error('Chain identifier not found in service info');
					}
					return response.chainId;
				}),
		catch: (cause): SuiPluginError =>
			suiPluginError(
				'chain-id-fetch',
				`sui chain-id fetch failed: ${formatUnknownError(cause)}`,
				cause,
			),
	}).pipe(
		Effect.timeoutOrElse({
			duration: timeout,
			orElse: (): Effect.Effect<string, SuiPluginError> =>
				Effect.fail(
					suiPluginError(
						'chain-id-fetch',
						`sui chain-id fetch did not respond within ${timeoutMs}ms`,
					),
				),
		}),
		Effect.tap((id: string) => Effect.annotateCurrentSpan({ [SuiSpans.chain]: id })),
		Effect.withSpan(opts?.span ?? 'devstack.plugin.sui.fetchChainId'),
	);
};

// ---------------------------------------------------------------------------
// waitForTransactionsReady — memoised, with manual invalidation
// ---------------------------------------------------------------------------

/** Per-attempt and total budget for the `waitForTransactionsReady`
 *  retry loop. The 2 s spacing matches the upstream sui-faucet's
 *  internal cadence; the 90 s ceiling matches the v3 service's
 *  documented wall-clock. */
const FUNDS_READY_RETRY_SPACING = Duration.seconds(2);
const FUNDS_READY_TIMEOUT = Duration.seconds(90);

/** Per-fetch deadline for the faucet probe POST. Bounded short so
 *  the outer retry loop hammers quickly. */
const PROBE_FETCH_TIMEOUT_MS = 3000;

/** Probe recipient for the faucet funds-ready check. A literal
 *  zero-balance address so the real call doesn't pollute caller wallets;
 *  any well-formed address works. */
const FAUCET_PROBE_RECIPIENT = '0x0000000000000000000000000000000000000000000000000000000000000001';

/**
 * Build the funds-transferable gate against a real HTTP faucet.
 * Memoised — first successful resolution sticks for the scope; the
 * manual `invalidate` surface clears the memo so long-running
 * supervisors can re-probe without a full restart.
 */
export const buildWaitForTransactionsReady = (
	faucetUrl: string,
	opts?: {
		readonly retrySpacing?: Duration.Duration;
		readonly timeout?: Duration.Duration;
	},
): Effect.Effect<WaitForTransactionsReady, never, Scope.Scope> =>
	Effect.gen(function* () {
		const retrySpacing = opts?.retrySpacing ?? FUNDS_READY_RETRY_SPACING;
		const timeout = opts?.timeout ?? FUNDS_READY_TIMEOUT;
		// SynchronizedRef serialises the get-or-init transition so two
		// concurrent callers can't both observe `null` and both build
		// their own `Effect.cached` instance (CAS-style guard against
		// the build-once race).
		const ref = yield* SynchronizedRef.make<Effect.Effect<void, SuiPluginError> | null>(null);

		const makeProbe = (): Effect.Effect<void, SuiPluginError> =>
			waitForHttpEndpoint({
				endpoint: `${faucetUrl}/v2/gas`,
				timeoutMs: Duration.toMillis(timeout),
				intervalMs: Duration.toMillis(retrySpacing),
				requestTimeoutMs: PROBE_FETCH_TIMEOUT_MS,
				requestInit: {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({
						FixedAmountRequest: { recipient: FAUCET_PROBE_RECIPIENT },
					}),
				},
				validate: async (response) => {
					if (!response.ok) throw new Error(`faucet HTTP ${response.status}`);
					const body = (await response.json()) as { status?: unknown };
					const status = body.status;
					if (typeof status === 'object' && status !== null && 'Failure' in status) {
						const failure = (status as { Failure: unknown }).Failure;
						throw new Error(`faucet body: Failure ${JSON.stringify(failure)}`);
					}
					return true;
				},
			}).pipe(
				Effect.mapError(
					(cause): SuiPluginError =>
						suiPluginError(
							'wait-funds-ready',
							`sui faucet at ${faucetUrl} did not become funds-transferable within ` +
								`${Duration.toMillis(timeout)}ms (still returning body-level Failure or 5xx): ` +
								formatUnknownError(cause),
							cause,
						),
				),
			);

		// `modifyEffect` atomically observes-then-updates inside a
		// serialised critical section: at most one fiber builds the
		// memoised probe, every other caller reads it back. This
		// closes the read-build-write race the plain Ref had.
		const getOrInit: Effect.Effect<Effect.Effect<void, SuiPluginError>> =
			SynchronizedRef.modifyEffect(ref, (existing) =>
				existing !== null
					? Effect.succeed([existing, existing] as const)
					: Effect.cached(makeProbe()).pipe(Effect.map((cached) => [cached, cached] as const)),
			);

		return {
			wait: getOrInit.pipe(Effect.flatMap((eff) => eff)),
			invalidate: SynchronizedRef.set(ref, null),
		};
	});

/** Trivially-succeeding gate. Used by faucet-less networks (live
 *  mainnet, fork — fork funds via impersonation, not HTTP). */
export const noopWaitForTransactionsReady: WaitForTransactionsReady = {
	wait: Effect.void,
	invalidate: Effect.void,
};

// ---------------------------------------------------------------------------
// SuiClient assembly — collapses the per-mode boilerplate
// ---------------------------------------------------------------------------

/** Build the `SuiSdkShim` over a constructed grpc client.
 *  Account/Coin/Wallet read through this seam, so we expose
 *  `executeTransaction` + `waitForTransaction` in addition to the
 *  read methods needed by the chain probe.
 *
 *  Every read/write goes through `sdkClient.core.*` — the gRPC
 *  TransportMethods surface from `@mysten/sui`. JSON-RPC is
 *  deprecated; do not reintroduce it. */
export const makeSdkShim = (sdkClient: SuiGrpcClient): SuiSdkShim => ({
	core: {
		getObject: (args) => sdkClient.core.getObject(args),
		getTransaction: (args) => sdkClient.core.getTransaction(args),
		getBalance: (args) => sdkClient.core.getBalance(args),
		listCoins: (args) => sdkClient.core.listCoins(args),
		// Extended surfaces — used by the account plugin's sign + execute
		// closure. Routes through `client.core.*` (the cross-transport
		// canonical surface per STYLE_GUIDE §16). The SDK accepts a
		// mutable `signatures: string[]`; the shim's readonly signature
		// is widened with a copy at the boundary.
		executeTransaction: (args) =>
			sdkClient.core.executeTransaction({
				transaction: args.transaction,
				signatures: [...args.signatures],
				...(args.include !== undefined ? { include: args.include } : {}),
			}),
		waitForTransaction: (args) =>
			sdkClient.core.waitForTransaction({
				digest: args.digest,
				...(args.timeout !== undefined ? { timeout: args.timeout } : {}),
			}),
	},
	// Client passthrough — Package's publish-tx builder hands this to
	// `Transaction.build({ client })`; sibling plugins reach
	// `client.core.*` directly through this slot. Typed as
	// ClientWithCoreApi via SuiSdkShim.client.
	client: sdkClient,
});

/** Assemble a `SuiClient` from the per-mode building blocks. The
 *  `fork: null` discriminator is invariant for non-fork modes; the
 *  fork builder constructs its own client with the admin surface.
 *
 *  `chain` is accepted as a bare string and branded to `ChainId` at
 *  this single boundary — every consumer downstream reads the
 *  branded shape so capability-key constructors (`chainProbe…`,
 *  `faucet…`) accept it without a cast.
 *
 *  Returns an `Effect` on the `SuiConfigError` channel: the empty-chain
 *  guard must surface as a typed, `catchTag`-able failure. Calling it
 *  un-yielded as a sync function (as it once was) turned a thrown
 *  `SuiConfigError` into a DEFECT inside the mode-boot `Effect.gen`
 *  bodies — a hidden crash the channel could never recover (mirrors the
 *  fix already applied to `auto-tick.ts`; STYLE_GUIDE §2). */
export const assembleSuiClient = (parts: {
	readonly sdkClient: SuiGrpcClient;
	readonly chain: string;
	readonly rpcUrl: string;
	readonly faucetUrl?: string;
	readonly fundingFaucetUrl?: string;
	readonly graphqlUrl?: string;
	readonly waitForTransactionsReady: WaitForTransactionsReady;
	/** Image ref consumed by package's path (b) (`docker run --rm`)
	 *  build path. `null` for modes that have no in-stack image
	 *  (external + live). */
	readonly buildImage?: import('../../../contracts/container-runtime.ts').ImageRef | null;
	/** Container-reachable mirrors. Local mode resolves public URLs
	 *  through the router but sibling containers still need direct
	 *  host-gateway URLs during boot. */
	readonly hostGateway?: SuiClient['hostGateway'];
}): Effect.Effect<
	{
		readonly client: SuiClient;
		readonly sdkShim: SuiSdkShim;
		readonly chainProbe: ChainProbe<SuiProbeKey>;
	},
	SuiConfigError
> =>
	Effect.gen(function* () {
		// Defense-in-depth — `fetchChainId` should never resolve to an
		// empty string (RPC rejects that earlier), but a branded empty
		// string would silently fold into every downstream cache key. A
		// caller-pinned `chain: ''` (e.g. `.live.custom({ chain: '' })`)
		// reaches here, so fail on the typed channel rather than throw.
		if (typeof parts.chain !== 'string' || parts.chain.length === 0) {
			return yield* Effect.fail(
				suiConfigError({
					field: 'chain',
					message: 'sui.assembleSuiClient: chain id must be a non-empty string',
					hint: 'check fetchChainId / network resolver returned a real chain id',
				}),
			);
		}
		const chain = parts.chain;
		const sdkShim = makeSdkShim(parts.sdkClient);
		const chainProbe = makeSuiChainProbe(sdkShim, chain);
		const client: SuiClient = {
			sdk: sdkShim,
			rpcUrl: parts.rpcUrl,
			faucetUrl: parts.faucetUrl ?? null,
			fundingFaucetUrl: parts.fundingFaucetUrl ?? parts.faucetUrl ?? null,
			graphqlUrl: parts.graphqlUrl ?? null,
			hostGateway: parts.hostGateway ?? {
				rpcUrl: toDockerHostGatewayUrl(parts.rpcUrl),
				faucetUrl: parts.faucetUrl === undefined ? null : toDockerHostGatewayUrl(parts.faucetUrl),
				graphqlUrl: parts.graphqlUrl === undefined ? null : toDockerHostGatewayUrl(parts.graphqlUrl),
			},
			chain: brandChainId(chain),
			waitForTransactionsReady: parts.waitForTransactionsReady,
			chainProbe,
			fork: null,
			buildImage: parts.buildImage ?? null,
		};
		return { client, sdkShim, chainProbe };
	});

/** Shape the resolved network record the boot builders all hand
 *  back. The substrate-network mapping is uniform per mode. Brands
 *  the raw chain string at this boundary so consumers downstream
 *  (codegen, capabilities, walrus/seal deps) read a `ChainId` and
 *  don't re-wrap. */
export const makeResolvedNetwork = (parts: {
	readonly mode: ResolvedSuiNetwork['mode'];
	readonly chain: string;
	readonly rpc: string;
	readonly faucet?: string;
	readonly graphql?: string;
	readonly source: ResolvedSuiNetwork['source'];
	readonly checkpoint?: string;
	readonly forkUpstream?: ResolvedSuiNetwork['forkUpstream'];
}): ResolvedSuiNetwork => ({
	mode: parts.mode,
	chain: brandChainId(parts.chain),
	rpc: parts.rpc,
	source: parts.source,
	...(parts.faucet !== undefined ? { faucet: parts.faucet } : {}),
	...(parts.graphql !== undefined ? { graphql: parts.graphql } : {}),
	...(parts.checkpoint !== undefined ? { checkpoint: parts.checkpoint } : {}),
	...(parts.forkUpstream !== undefined ? { forkUpstream: parts.forkUpstream } : {}),
});
