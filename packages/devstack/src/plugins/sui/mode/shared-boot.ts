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

import { Duration, Effect, Ref, type Scope } from 'effect';

import type { SuiGrpcClient } from '@mysten/sui/grpc';

import type { ChainProbe } from '../../../contracts/chain-probe.ts';
import { chainId as brandChainId } from '../../../substrate/brand.ts';
import { waitForHttpEndpoint } from '../../../substrate/runtime/http-probe.ts';
import { makeSuiChainProbe, type SuiSdkShim, type SuiProbeKey } from '../chain-probe.ts';
import { suiPluginError, type SuiPluginError } from '../errors.ts';
import type { ResolvedSuiNetwork } from '../network-resolver.ts';
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
				`sui chain-id fetch failed: ${stringifyCause(cause)}`,
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
		Effect.tap((id: string) => Effect.annotateCurrentSpan({ 'sui.chain': id })),
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
		const ref = yield* Ref.make<Effect.Effect<void, SuiPluginError> | null>(null);

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
								stringifyCause(cause),
							cause,
						),
				),
			);

		const getOrInit: Effect.Effect<Effect.Effect<void, SuiPluginError>> = Effect.gen(function* () {
			const existing = yield* Ref.get(ref);
			if (existing !== null) return existing;
			const cached = yield* Effect.cached(makeProbe());
			yield* Ref.set(ref, cached);
			return cached;
		});

		return {
			wait: getOrInit.pipe(Effect.flatMap((eff) => eff)),
			invalidate: Ref.set(ref, null),
		};
	});

/** Trivially-succeeding gate. Used by faucet-less networks (live
 *  mainnet, fork — fork funds via impersonation, not HTTP). */
export const noopWaitForTransactionsReady: WaitForTransactionsReady = {
	wait: Effect.void,
	invalidate: Effect.void,
};

const SUI_RPC_READ_TIMEOUT_MS = 10_000;

const postJsonRpc = async <A>(
	rpcUrl: string,
	method: string,
	params: ReadonlyArray<unknown>,
): Promise<A> => {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), SUI_RPC_READ_TIMEOUT_MS);
	timeout.unref?.();
	try {
		const response = await fetch(rpcUrl, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
			signal: controller.signal,
		});
		if (!response.ok) throw new Error(`Sui RPC HTTP ${response.status}`);
		const payload = (await response.json()) as {
			readonly result?: A;
			readonly error?: { readonly message?: string };
		};
		if (payload.error !== undefined) {
			throw new Error(payload.error.message ?? JSON.stringify(payload.error));
		}
		if (payload.result === undefined) throw new Error(`Sui RPC ${method} returned no result`);
		return payload.result;
	} finally {
		clearTimeout(timeout);
	}
};

const normalizeJsonOwner = (owner: unknown): unknown => {
	if (owner === 'Immutable') return { $kind: 'Immutable', Immutable: true };
	if (typeof owner !== 'object' || owner === null) return { $kind: 'Unknown', Unknown: owner };
	const record = owner as {
		readonly AddressOwner?: unknown;
		readonly ObjectOwner?: unknown;
		readonly Shared?: { readonly initial_shared_version?: unknown; readonly initialSharedVersion?: unknown };
		readonly ConsensusAddressOwner?: unknown;
	};
	if (typeof record.AddressOwner === 'string') {
		return { $kind: 'AddressOwner', AddressOwner: record.AddressOwner };
	}
	if (record.ObjectOwner !== undefined) {
		return { $kind: 'Parent', Parent: record.ObjectOwner };
	}
	if (record.Shared !== undefined) {
		const initialSharedVersion =
			record.Shared.initialSharedVersion ?? record.Shared.initial_shared_version;
		return {
			$kind: 'Shared',
			Shared: { initialSharedVersion: String(initialSharedVersion) },
		};
	}
	if (record.ConsensusAddressOwner !== undefined) {
		return { $kind: 'ConsensusAddressOwner', ConsensusAddressOwner: record.ConsensusAddressOwner };
	}
	return { $kind: 'Unknown', Unknown: owner };
};

const getObjectViaJsonRpc = async (
	rpcUrl: string,
	args: {
		readonly objectId: string;
		readonly include?: {
			readonly content?: boolean;
			readonly json?: boolean;
		};
	},
): Promise<unknown> => {
	const showContent = args.include?.content === true || args.include?.json === true;
	const result = await postJsonRpc<{
		readonly data?: {
			readonly objectId?: string;
			readonly version?: string | number;
			readonly type?: string;
			readonly owner?: unknown;
			readonly content?: {
				readonly fields?: unknown;
			};
		};
	}>('' + rpcUrl, 'sui_getObject', [
		args.objectId,
		{ showType: true, showOwner: true, showContent },
	]);
	const data = result.data;
	if (data?.objectId === undefined) throw new Error(`object ${args.objectId} not found`);
	const object = {
		objectId: data.objectId,
		version: String(data.version ?? ''),
		type: data.type ?? 'unknown',
		owner: normalizeJsonOwner(data.owner),
		...(args.include?.json === true ? { json: data.content?.fields } : {}),
		...(args.include?.content === true ? { content: data.content } : {}),
	};
	return { ...object, object };
};

// ---------------------------------------------------------------------------
// SuiClient assembly — collapses the per-mode boilerplate
// ---------------------------------------------------------------------------

/** Build the `SuiSdkShim` over a constructed grpc client.
 *  Account/Coin/Wallet read through this seam, so we expose
 *  `executeTransaction` + `waitForTransaction` in addition to the
 *  read methods needed by the chain probe. */
export const makeSdkShim = (sdkClient: SuiGrpcClient, rpcUrl: string): SuiSdkShim => ({
	core: {
		getObject: (args) => getObjectViaJsonRpc(rpcUrl, args),
		getTransaction: (args) => sdkClient.core.getTransaction(args),
		getBalance: (args) => sdkClient.core.getBalance(args),
		// Extended surfaces — used by the account plugin's sign + execute
		// closure. Local mode keeps the `sdkClient.executeTransaction` /
		// `sdkClient.waitForTransaction` instance methods reachable on
		// the shim so consumers don't have to know about the grpc client
		// constructor. The SDK accepts a mutable `signatures: string[]`
		// shape; the shim's readonly signature is widened with a copy at
		// the boundary.
		executeTransaction: (args) =>
			sdkClient.executeTransaction({
				transaction: args.transaction,
				signatures: [...args.signatures],
				...(args.include !== undefined ? { include: args.include } : {}),
			}),
		waitForTransaction: (args) =>
			sdkClient.waitForTransaction({
				digest: args.digest,
				...(args.timeout !== undefined ? { timeout: args.timeout } : {}),
			}),
	},
	// Opaque client passthrough — the Package plugin's publish-tx
	// builder hands this to `Transaction.build({ client })`. The shim
	// layer doesn't type-narrow it; downstream consumers cast at the
	// `tx.build` call site (mirrors coin/mint.ts).
	client: sdkClient,
});

/** Assemble a `SuiClient` from the per-mode building blocks. The
 *  `fork: null` discriminator is invariant for non-fork modes; the
 *  fork builder constructs its own client with the admin surface.
 *
 *  `chain` is accepted as a bare string and branded to `ChainId` at
 *  this single boundary — every consumer downstream reads the
 *  branded shape so capability-key constructors (`chainProbe…`,
 *  `faucet…`) accept it without a cast. */
export const assembleSuiClient = (parts: {
	readonly sdkClient: SuiGrpcClient;
	readonly chain: string;
	readonly rpcUrl: string;
	readonly sdkRpcUrl?: string;
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
}): {
	readonly client: SuiClient;
	readonly sdkShim: SuiSdkShim;
	readonly chainProbe: ChainProbe<SuiProbeKey>;
} => {
	const sdkShim = makeSdkShim(parts.sdkClient, parts.sdkRpcUrl ?? parts.rpcUrl);
	const chainProbe = makeSuiChainProbe(sdkShim, parts.chain);
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
		chain: brandChainId(parts.chain),
		waitForTransactionsReady: parts.waitForTransactionsReady,
		chainProbe,
		fork: null,
		buildImage: parts.buildImage ?? null,
	};
	return { client, sdkShim, chainProbe };
};

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
}): ResolvedSuiNetwork => ({
	mode: parts.mode,
	chain: brandChainId(parts.chain),
	rpc: parts.rpc,
	source: parts.source,
	...(parts.faucet !== undefined ? { faucet: parts.faucet } : {}),
	...(parts.graphql !== undefined ? { graphql: parts.graphql } : {}),
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const stringifyCause = (cause: unknown): string => {
	if (cause instanceof Error) return cause.message;
	if (typeof cause === 'string') return cause;
	try {
		return JSON.stringify(cause);
	} catch {
		return String(cause);
	}
};
