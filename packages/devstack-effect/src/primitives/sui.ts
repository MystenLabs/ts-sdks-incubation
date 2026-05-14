// Sui chain primitives.
//
// Phase 3 collapsed the previously-internal `class Sui` here onto the
// canonical interface tag in `src/interfaces/sui.ts`. We re-export it so
// downstream primitives (`seal`, `walrus`, `accounts`, `publish-move`,
// `wallet-app`, `tx`, `deepbook`) keep their existing `import { Sui }
// from './sui.js'` paths working — both refer to the SAME class
// (Context key `'@devstack/Sui'`).
//
// Factory shape:
//
//   suiLocalnet({...})  — build a native-arch sui-localnet image from the
//                         vendored `sui-image/` Dockerfile and run it with
//                         embedded faucet, GraphQL, and an `--with-indexer`
//                         postgres sidecar.
//   suiTestnet({...})   — RPC-only handle pointing at `fullnode.testnet.sui.io`
//                         + faucet at `faucet.testnet.sui.io`. No container.
//   suiMainnet({...})   — RPC-only handle pointing at `fullnode.mainnet.sui.io`.
//                         No faucet.
//   suiCustom({...})    — open-ended RPC-only handle for corporate fullnodes,
//                         pinned forks, or air-gapped mirrors.
//
// Every factory returns `{ __layer, key }` via `provideTag(Sui, …)`, so
// `defineDevstack` and `provideDevstack` route them through Context
// identically.

import { Effect, Layer, Schedule } from 'effect';
import { SuiJsonRpcClient } from '@mysten/sui/jsonRpc';
import * as Docker from '../internal/docker.js';
import { Sui, type SuiShape } from '../interfaces/sui.js';
import { stringifyCause } from '../internal/stringify-cause.js';
import { Identity } from '../internal/identity.js';
import { PortAllocator } from '../internal/port-allocator.js';
import { EndpointRegistry } from '../internal/registries.js';
import { SuiBuildImage } from '../internal/sui-cli.js';
import { dockerImage } from '../plugin-author/index.js';
import { provideTag, setPhase } from '../tag.js';
import type { StackMember } from '../define-devstack.js';
import { SuiError } from './errors.js';

// Re-export the canonical Sui tag so downstream primitives keep their
// existing `import { Sui } from './sui.js'` paths. `Sui` here and `Sui`
// in `interfaces/sui.ts` are the SAME class (shared Context key).
export { Sui, type SuiShape };

export type SuiNetwork = 'localnet' | 'testnet' | 'mainnet';

// Pinned upstream Sui release. The `sui-image/` Dockerfile downloads
// the matching `ubuntu-aarch64` / `ubuntu-x86_64` tarball at build time
// so the resulting image runs natively on the host architecture —
// `mysten/sui-tools` ships amd64 only, which forces Rosetta emulation
// on Apple Silicon and stretches `sui start` genesis from ~10 s to 5+
// minutes. Bump in lockstep with the matching walrus / seal versions
// (or the Move package ABIs drift). Mirrors v3's `SUI_DEFAULT_VERSION`.
const DEFAULT_SUI_VERSION = 'devnet-v1.71.0';

// In-container ports the sui binary binds on. Host ports come from
// the shared `PortAllocator` so two stacks can run side-by-side; the
// resulting URLs are constructed at runtime from the allocated host
// ports. `LOCAL_FAUCET_URL` is still emitted as a fallback for the
// `options.rpcUrl`-but-no-`faucetUrl` branch where the caller pinned
// the RPC explicitly (no localnet container started here).
const LOCAL_RPC_PORT = 9000;
const LOCAL_FAUCET_PORT = 9123;
const LOCAL_GRAPHQL_PORT = 9125;
// Faucet URLs are stored as BASES — `/v2/gas` is appended by the
// faucet client (`internal/faucet.ts`). Matches v3's convention.
const LOCAL_FAUCET_URL = `http://localhost:${LOCAL_FAUCET_PORT}`;

// Postgres sidecar that backs `sui start --with-indexer`'s database.
// The sui CLI requires a real postgres URL — there's no embedded
// option — so we run a `postgres:16-alpine` on the same per-stack
// docker network. Only the sui process talks to it (via the in-network
// alias); no host port mapping. Mirrors v3's `sui.ts` plugin.
const SUI_INDEXER_DB_IMAGE = 'postgres:16-alpine';
const SUI_INDEXER_DB_NETWORK_ALIAS = 'sui-indexer-db';
const SUI_LOCALNET_NETWORK_ALIAS = 'sui-localnet';
const SUI_INDEXER_DB_USER = 'sui';
const SUI_INDEXER_DB_PASSWORD = 'sui';
const SUI_INDEXER_DB_NAME = 'sui_indexer';
const SUI_INDEXER_DATABASE_URL = `postgres://${SUI_INDEXER_DB_USER}:${SUI_INDEXER_DB_PASSWORD}@${SUI_INDEXER_DB_NETWORK_ALIAS}:5432/${SUI_INDEXER_DB_NAME}`;

export interface SuiLocalnetOptions {
	/** Pre-built image reference (e.g. a locally-built arm64 tag or an
	 *  air-gapped mirror). When set, `version` is ignored and the
	 *  vendored `sui-image/` build is skipped. */
	readonly image?: string;
	/** Sui release tag passed as `SUI_VERSION` to the vendored
	 *  `sui-image/` Dockerfile. The Dockerfile downloads the matching
	 *  `ubuntu-aarch64` / `ubuntu-x86_64` tarball at build time so the
	 *  image runs natively on the host architecture. Default
	 *  `'devnet-v1.71.0'`. Ignored when `image` is set. */
	readonly version?: string;
	/** Pre-existing RPC base. When set, `suiLocalnet` skips the container
	 *  body and just wraps an externally-managed localnet. */
	readonly rpcUrl?: string;
	readonly faucetUrl?: string;
	readonly graphqlUrl?: string;
	readonly ports?: Readonly<Record<number, number>>;
	readonly readyTimeoutMs?: number;
}

/**
 * Start a sui-localnet container with embedded faucet, indexer postgres
 * sidecar, and GraphQL. Builds a native-arch image from the vendored
 * `sui-image/` Dockerfile unless `options.image` overrides. Returns a
 * `StackMember` targeting the canonical `Sui` tag.
 */
export const suiLocalnet = (options: SuiLocalnetOptions = {}): StackMember => {
	const version = options.version ?? DEFAULT_SUI_VERSION;

	// Sibling tag for the localnet image. `dockerImage({build})` is
	// content-addressed — the tag folds in a hash of the Dockerfile +
	// entrypoint.sh + `SUI_VERSION`, so an edit to any of those flips the
	// tag and forces a rebuild while identical inputs hit the docker
	// cache. Skipped when the caller pins a pre-built tag via `image`.
	const dockerContext = new URL('../../sui-image/', import.meta.url).pathname;
	const localnetImage =
		options.image === undefined
			? dockerImage({
					name: 'sui.image',
					build: {
						context: dockerContext,
						dockerfile: 'Dockerfile',
						buildArgs: { SUI_VERSION: version },
					},
				})
			: undefined;

	const build = Effect.fn('suiLocalnet')(function* () {
		// Localnet with externally-managed RPC.
		if (options.rpcUrl !== undefined) {
			const rpcUrl = options.rpcUrl;
			const faucetUrl = options.faucetUrl ?? LOCAL_FAUCET_URL;
			const client = new SuiJsonRpcClient({ url: rpcUrl, network: 'localnet' });
			yield* EndpointRegistry.publish({ name: 'sui-rpc', url: rpcUrl, kind: 'rpc' });
			yield* EndpointRegistry.publish({ name: 'sui-faucet', url: faucetUrl, kind: 'faucet' });
			const chainId = yield* fetchChainId(client);
			return {
				network: 'localnet',
				rpcUrl,
				faucetUrl,
				// TODO: surface a localnet graphql endpoint when one exists
				graphqlUrl: undefined,
				client,
				chainId,
			} satisfies SuiShape;
		}

		// Localnet container — start the vendored sui image with embedded
		// faucet, indexer + graphql. The indexer requires a real postgres
		// so we run one as a sidecar on a per-stack docker network and
		// point `--with-indexer` at it via the in-network DNS alias.
		let image: string;
		if (options.image !== undefined) {
			image = options.image;
		} else {
			yield* setPhase('building image');
			image = (yield* localnetImage!).tag;
		}
		// Host ports are allocator-driven so two stacks (or sibling
		// example projects sharing a host) don't fight over 9000 /
		// 9123 / 9125. The allocator scans forward when the preferred
		// port is busy; the in-container ports stay fixed because the
		// sui binary's `--with-faucet`/`--with-graphql` flags reference
		// the in-container ports. Caller's `options.ports` short-circuits
		// the allocator path for the rare case they want pinned host
		// ports anyway.
		let ports: Record<number, number>;
		let hostRpcPort: number;
		let hostFaucetPort: number;
		let hostGraphqlPort: number;
		if (options.ports !== undefined) {
			ports = options.ports;
			// Best-effort reverse lookup: find the host port mapped to
			// each in-container default. Fall back to the in-container
			// value (assumes 1:1) when no entry matches.
			const findHost = (containerPort: number): number => {
				for (const [h, c] of Object.entries(ports)) {
					if (c === containerPort) return Number(h);
				}
				return containerPort;
			};
			hostRpcPort = findHost(LOCAL_RPC_PORT);
			hostFaucetPort = findHost(LOCAL_FAUCET_PORT);
			hostGraphqlPort = findHost(LOCAL_GRAPHQL_PORT);
		} else {
			const allocator = yield* PortAllocator;
			const allocSui = (preferred: number) =>
				allocator
					.allocate(preferred)
					.pipe(
						Effect.catchTag('PortAllocatorError', (cause) =>
							Effect.fail(
								new SuiError({
									phase: 'sui-up',
									message: `sui-localnet: could not allocate host port near ${preferred}: ${cause.message}`,
									cause,
								}),
							),
						),
					);
			hostRpcPort = yield* allocSui(LOCAL_RPC_PORT);
			hostFaucetPort = yield* allocSui(LOCAL_FAUCET_PORT);
			hostGraphqlPort = yield* allocSui(LOCAL_GRAPHQL_PORT);
			ports = {
				[hostRpcPort]: LOCAL_RPC_PORT,
				[hostFaucetPort]: LOCAL_FAUCET_PORT,
				[hostGraphqlPort]: LOCAL_GRAPHQL_PORT,
			};
		}

		// Per-stack docker network — gives the indexer db + sui-localnet
		// stable in-network DNS aliases so the sui process can dial
		// `sui-indexer-db:5432` regardless of host port mapping. Default
		// bridge IPAM is fine: nothing here pins a fixed IP via
		// `Docker.run({ip})`, and a pinned /24 routinely collides with
		// other docker networks on the host (walrus, leftover compose
		// projects). Network name folds in `Identity.stack` so parallel
		// stacks of the same app don't collide on the network.
		const identity = yield* Identity;
		const networkName =
			identity.stack === 'main'
				? `${identity.app}-sui-network`
				: `${identity.app}-${identity.stack}-sui-network`;
		yield* Docker.networkCreate(networkName).pipe(
			Effect.catchTag('DockerError', (cause) =>
				Effect.fail(
					new SuiError({
						phase: 'network-create',
						message: `failed to create sui docker network '${networkName}'`,
						cause,
					}),
				),
			),
		);

		// Postgres sidecar — internal only, no host port mapping. The
		// indexer-db must be live before sui-localnet starts because
		// `--with-indexer` retries internally but only briefly, so we
		// gate the next step on a `pg_isready` probe (below).
		//
		// Named volume on `/var/lib/postgresql/data` so the indexer's
		// populated schema + row data survives `docker rm -f` on Ctrl-C.
		// Without this, every process restart starts postgres fresh and
		// sui's `--with-indexer` has to re-index from checkpoint 0 — the
		// GraphQL endpoint serves stale/empty results until catchup
		// completes, so a dapp that reads on-chain state via GraphQL
		// (e.g. listing active lobbies) sees "no games" right after a
		// resume even though the chain itself has them. Volume name is
		// per-(app, stack) to match the sui-data volume.
		const indexerDbVolume =
			identity.stack === 'main'
				? `devstack-${identity.app}-sui-indexer-db`
				: `devstack-${identity.app}-${identity.stack}-sui-indexer-db`;
		yield* setPhase('starting indexer-db');
		const indexerDb = yield* Docker.run({
			name: 'sui.indexer-db',
			image: SUI_INDEXER_DB_IMAGE,
			env: {
				POSTGRES_USER: SUI_INDEXER_DB_USER,
				POSTGRES_PASSWORD: SUI_INDEXER_DB_PASSWORD,
				POSTGRES_DB: SUI_INDEXER_DB_NAME,
			},
			network: networkName,
			networkAlias: SUI_INDEXER_DB_NETWORK_ALIAS,
			mounts: [{ host: indexerDbVolume, container: '/var/lib/postgresql/data' }],
			detach: true,
		}).pipe(
			Effect.catchTag('DockerError', (cause) =>
				Effect.fail(
					new SuiError({
						phase: 'postgres-up',
						message: 'failed to start sui indexer-db container',
						cause,
					}),
				),
			),
		);
		yield* awaitIndexerDbReady(indexerDb.containerId);

		// The vendored entrypoint `exec sui "$@"`, so args are passed
		// directly to `sui` (no leading `sui` arg). The entrypoint also
		// runs a one-time `sui genesis` if no on-disk config exists, so
		// we drop `--force-regenesis` — the entrypoint's persistent
		// genesis is what lets `docker stop`/`start` preserve chain state.
		//
		// Named volume mounted at `/root/.sui` so chain state (the genesis
		// config, RocksDB authority store, accumulators, faucet config)
		// survives `docker rm`. Without this the writable-layer state dies
		// with the container on Ctrl-C, the next process re-genesises with
		// a brand-new chain id, and the publishMove state-store cache
		// misses on every restart — visible as new packageIds on every
		// `pnpm dev`. Volume name is per-(app, stack) so two stacks of the
		// same app don't share genesis. `devstack wipe` removes this
		// volume alongside the containers.
		const suiDataVolume =
			identity.stack === 'main'
				? `devstack-${identity.app}-sui-data`
				: `devstack-${identity.app}-${identity.stack}-sui-data`;
		yield* setPhase('starting localnet');
		yield* Docker.run({
			name: 'sui.localnet',
			image,
			args: [
				'start',
				'--with-faucet=0.0.0.0:9123',
				`--with-indexer=${SUI_INDEXER_DATABASE_URL}`,
				'--with-graphql=0.0.0.0:9125',
			],
			ports,
			network: networkName,
			networkAlias: SUI_LOCALNET_NETWORK_ALIAS,
			mounts: [{ host: suiDataVolume, container: '/root/.sui' }],
			detach: true,
		}).pipe(
			Effect.catchTag('DockerError', (cause) =>
				Effect.fail(
					new SuiError({
						phase: 'sui-up',
						message: 'failed to start sui localnet container',
						cause,
					}),
				),
			),
		);

		// URLs use the ALLOCATED host ports (not the in-container
		// defaults) so dapp-kit / SDKs / browser clients dial whatever
		// port the allocator picked. Falls back to the in-container
		// defaults when the caller passed `options.ports` (matches the
		// pre-allocator behaviour).
		const rpcUrl = `http://localhost:${hostRpcPort}`;
		const faucetUrl = `http://localhost:${hostFaucetPort}`;
		const graphqlUrl = `http://localhost:${hostGraphqlPort}/graphql`;
		const client = new SuiJsonRpcClient({ url: rpcUrl, network: 'localnet' });

		// Gate `Sui` readiness on ALL three endpoints actually serving:
		//   - JSON-RPC: real method call (bare GET returns 405)
		//   - Faucet: POST against a sentinel address — endpoint must
		//     accept the request (status doesn't matter, just connection)
		//   - GraphQL: POST `{ chainIdentifier }` against /graphql
		// Without the faucet + graphql gates, downstream accounts.fund
		// fires too early against a not-yet-ready faucet and gets
		// `fetch failed`. Native genesis settles in ~10 s; 60 s ceiling
		// absorbs first-build jitter.
		yield* setPhase('awaiting rpc + faucet + graphql');
		// 120s default (was 60s). The faucet's HTTP socket binds early but
		// the underlying sui-faucet binary takes a beat to be able to
		// execute its first tx — until then it returns 200 OK with a
		// body-level `status: { Failure: { Internal: "..." } }`. The
		// real-funding probe below catches that, but the retry budget
		// needs to be wide enough to absorb the warm-up window.
		const readyTimeoutMs = options.readyTimeoutMs ?? 120_000;
		const rpcProbe = Effect.tryPromise({
			try: () => client.getChainIdentifier(),
			catch: (cause) => new Error(`rpc: ${stringifyCause(cause)}`),
		}).pipe(Effect.withSpan('sui.probe.rpc'));
		// Faucet probe: actually request funds for a stable throwaway
		// recipient and verify the response body is `status: "Success"`.
		// The prior `status < 500` check passed during the warm-up
		// window when the faucet returned 200 with a body-level
		// `{"status": {"Failure": ...}}` — the supervisor declared Sui
		// "ready" and downstream funding immediately tripped the 90s
		// faucet timeout. Gating on a real tx success means Sui isn't
		// marked ready until the faucet can actually fund.
		const faucetProbe = faucetReadyProbe(faucetUrl).pipe(
			Effect.withSpan('sui.probe.faucet'),
		);
		const graphqlProbe = Effect.tryPromise({
			try: () =>
				fetch(graphqlUrl, {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ query: '{ chainIdentifier }' }),
				}).then((r) => {
					if (!r.ok) throw new Error(`graphql: ${r.status}`);
				}),
			catch: (cause) => new Error(`graphql: ${stringifyCause(cause)}`),
		}).pipe(Effect.withSpan('sui.probe.graphql'));
		yield* Effect.all([rpcProbe, faucetProbe, graphqlProbe], {
			concurrency: 'unbounded',
		}).pipe(
			Effect.retry(Schedule.spaced('1 seconds')),
			Effect.timeoutOrElse({
				duration: `${readyTimeoutMs} millis`,
				orElse: () =>
					Effect.fail(
						new SuiError({
							phase: 'ready-probe',
							message: `sui localnet did not become fully ready (rpc + faucet + graphql) within ${readyTimeoutMs}ms`,
						}),
					),
			}),
		);

		yield* EndpointRegistry.publish({ name: 'sui-rpc', url: rpcUrl, kind: 'rpc' });
		yield* EndpointRegistry.publish({ name: 'sui-faucet', url: faucetUrl, kind: 'faucet' });
		yield* EndpointRegistry.publish({ name: 'sui-graphql', url: graphqlUrl, kind: 'graphql' });
		// Postgres sidecar is internal only — register it so it shows up
		// in the manifest for debuggability, but mark `kind: 'internal'`
		// so user-facing surfaces (TUI, etc.) can elide it.
		yield* EndpointRegistry.publish({
			name: 'sui-indexer-db',
			url: SUI_INDEXER_DATABASE_URL,
			kind: 'internal',
		});

		const chainId = yield* fetchChainId(client);

		return {
			network: 'localnet',
			rpcUrl,
			faucetUrl,
			graphqlUrl,
			client,
			chainId,
		} satisfies SuiShape;
	})();

	const { __layer, key, __kind, __displayTitle } = provideTag(Sui, build, {
		kind: 'service',
		displayTitle: 'sui.localnet',
		display: (s) => {
			// Localnet exposes RPC + faucet + GraphQL on stable ports. Surface
			// all three so the user can copy each independently. `endpoints`
			// suppresses the redundant `primary` in the TUI's row layout —
			// the URL already lives in the first endpoint line.
			const endpoints: Array<{ readonly label: string; readonly url: string }> = [
				{ label: 'rpc', url: s.rpcUrl },
			];
			if (s.faucetUrl !== undefined) endpoints.push({ label: 'faucet', url: s.faucetUrl });
			if (s.graphqlUrl !== undefined) endpoints.push({ label: 'graphql', url: s.graphqlUrl });
			return {
				title: `sui.${s.network}`,
				...(endpoints.length > 1 ? { endpoints } : { primary: s.rpcUrl }),
			};
		},
	});
	// Surface the sibling image layer alongside our own — defineDevstack's
	// mergeAll prefers `__layers` when present so the dockerImage build
	// runs as a peer entry in the engine instead of getting lost inside
	// our build body. Provider-before-consumer ordering matters here:
	// `composeStackLayer` folds the list with `provideMerge`, so the
	// image layer must appear BEFORE our own `__layer` (which depends on
	// the image's `sui.image` tag inside its build body). When
	// `options.image` overrides we skip the build entirely, so the only
	// layer is our own.
	//
	// We ALSO surface a `SuiBuildImage` reference (`Layer.effect`) so
	// downstream `buildMove` callers (publishMove, seal) dispatch `sui
	// move build` INTO the localnet image rather than against the host
	// `sui` CLI. The host's sui may be newer than `devnet-v1.71.0` and
	// reject flags (`--json` was renamed) the in-image sui still
	// requires. When a caller pins `options.image` we use that tag
	// directly; otherwise we yield the built image's tag from its
	// own layer. When the localnet has no associated image at all
	// (externally-managed RPC via `options.rpcUrl`), we still publish
	// the explicit-image tag if one was supplied — version-skew bites
	// remote localnets too — and fall back to the default (undefined,
	// host-CLI) otherwise.
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const baseLayers: ReadonlyArray<Layer.Layer<any, any, any>> =
		localnetImage !== undefined ? [...localnetImage.__layers, __layer] : [__layer];

	// `SuiBuildImage` is a `Context.Reference` (Identifier=`never`), so
	// `Layer.succeed(SuiBuildImage, …)` and `Layer.effect(SuiBuildImage, …)`
	// both produce `Layer<never, …, …>` — references populate the Context
	// slot without surfacing in `ROut`. The `Layer.effect` branch's body
	// yields from the sibling `localnetImage` tag, so its `RIn` carries
	// that tag's Identifier. We bind the variable to `Layer.Any` (the
	// canonical "some Layer" constraint) so both branches assign without
	// a cast, and let the final `layers` array widen via the existing
	// `Layer<any,any,any>` element type at its declaration site.
	let buildImageLayer: Layer.Any | undefined;
	if (options.image !== undefined) {
		const pinned = options.image;
		buildImageLayer = Layer.succeed(SuiBuildImage, { tag: pinned });
	} else if (localnetImage !== undefined) {
		buildImageLayer = Layer.effect(
			SuiBuildImage,
			Effect.gen(function* () {
				const img = yield* localnetImage;
				return { tag: img.tag };
			}),
		);
	}
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const layers: ReadonlyArray<Layer.Layer<any, any, any>> =
		buildImageLayer !== undefined
			? [...baseLayers, buildImageLayer as Layer.Layer<any, any, any>]
			: baseLayers;
	return { __layer, __layers: layers, key, __kind, __displayTitle };
};

export interface SuiTestnetOptions {
	readonly rpcUrl?: string;
	readonly faucetUrl?: string;
	readonly graphqlUrl?: string;
}

/**
 * RPC-only Sui handle wired to `fullnode.testnet.sui.io` (or a caller-
 * supplied URL). No container, no indexer — just a `SuiJsonRpcClient`.
 */
export const suiTestnet = (options: SuiTestnetOptions = {}): StackMember => {
	const build = Effect.fn('suiTestnet')(function* () {
		const rpcUrl = options.rpcUrl ?? 'https://fullnode.testnet.sui.io:443';
		const faucetUrl = options.faucetUrl ?? 'https://faucet.testnet.sui.io';
		const graphqlUrl = options.graphqlUrl ?? 'https://sui-testnet.mystenlabs.com/graphql';
		const client = new SuiJsonRpcClient({ url: rpcUrl, network: 'testnet' });
		yield* EndpointRegistry.publish({ name: 'sui-rpc', url: rpcUrl, kind: 'rpc' });
		yield* EndpointRegistry.publish({ name: 'sui-faucet', url: faucetUrl, kind: 'faucet' });
		yield* EndpointRegistry.publish({ name: 'sui-graphql', url: graphqlUrl, kind: 'graphql' });
		const chainId = yield* fetchChainId(client);
		return {
			network: 'testnet',
			rpcUrl,
			faucetUrl,
			graphqlUrl,
			client,
			chainId,
		} satisfies SuiShape;
	})();

	const { __layer, key, __kind, __displayTitle } = provideTag(Sui, build, {
		kind: 'service',
		displayTitle: 'sui.testnet',
		display: (s) => {
			const endpoints: Array<{ readonly label: string; readonly url: string }> = [
				{ label: 'rpc', url: s.rpcUrl },
			];
			if (s.faucetUrl !== undefined) endpoints.push({ label: 'faucet', url: s.faucetUrl });
			if (s.graphqlUrl !== undefined) endpoints.push({ label: 'graphql', url: s.graphqlUrl });
			return {
				title: `sui.${s.network}`,
				...(endpoints.length > 1 ? { endpoints } : { primary: s.rpcUrl }),
			};
		},
	});
	return { __layer, key, __kind, __displayTitle };
};

export interface SuiMainnetOptions {
	readonly rpcUrl?: string;
	readonly graphqlUrl?: string;
}

/**
 * RPC-only Sui handle wired to `fullnode.mainnet.sui.io` (or a caller-
 * supplied URL). No faucet — mainnet has none. Use this for read-only
 * production reads or pre-flight checks; never feed signers a `suiMainnet`
 * handle unless you really mean it.
 */
export const suiMainnet = (options: SuiMainnetOptions = {}): StackMember => {
	const build = Effect.fn('suiMainnet')(function* () {
		const rpcUrl = options.rpcUrl ?? 'https://fullnode.mainnet.sui.io:443';
		const graphqlUrl = options.graphqlUrl ?? 'https://sui-mainnet.mystenlabs.com/graphql';
		const client = new SuiJsonRpcClient({ url: rpcUrl, network: 'mainnet' });
		yield* EndpointRegistry.publish({ name: 'sui-rpc', url: rpcUrl, kind: 'rpc' });
		yield* EndpointRegistry.publish({ name: 'sui-graphql', url: graphqlUrl, kind: 'graphql' });
		const chainId = yield* fetchChainId(client);
		return {
			network: 'mainnet',
			rpcUrl,
			faucetUrl: undefined,
			graphqlUrl,
			client,
			chainId,
		} satisfies SuiShape;
	})();

	const { __layer, key, __kind, __displayTitle } = provideTag(Sui, build, {
		kind: 'service',
		displayTitle: 'sui.mainnet',
		display: (s) => {
			const endpoints: Array<{ readonly label: string; readonly url: string }> = [
				{ label: 'rpc', url: s.rpcUrl },
			];
			if (s.graphqlUrl !== undefined) endpoints.push({ label: 'graphql', url: s.graphqlUrl });
			return {
				title: `sui.${s.network}`,
				...(endpoints.length > 1 ? { endpoints } : { primary: s.rpcUrl }),
			};
		},
	});
	return { __layer, key, __kind, __displayTitle };
};

export interface SuiCustomOptions {
	readonly rpcUrl: string;
	readonly faucetUrl?: string;
	readonly graphqlUrl?: string;
	/** Free-form network label (e.g. `'corp-fork'`, `'devnet-pin'`). The
	 *  canonical `SuiShape.network` accepts any string so downstream
	 *  primitives that fold it into cache keys / labels stay sound. */
	readonly network?: string;
}

/**
 * Open-ended Sui handle for corporate RPCs, pinned forks, or any other
 * non-mystenlabs endpoint. Caller supplies `rpcUrl`; everything else is
 * optional.
 */
export const suiCustom = (options: SuiCustomOptions): StackMember => {
	const build = Effect.fn('suiCustom')(function* () {
		const rpcUrl = options.rpcUrl;
		const faucetUrl = options.faucetUrl;
		const graphqlUrl = options.graphqlUrl;
		const network = options.network ?? 'custom';
		// `SuiJsonRpcClient` expects a known `network` literal; pass
		// 'localnet' as the wire-level default to suppress its internal
		// chain-id mismatch warning. The surface-level `network` we return
		// in `SuiShape` is the caller-supplied label.
		const client = new SuiJsonRpcClient({ url: rpcUrl, network: 'localnet' });
		yield* EndpointRegistry.publish({ name: 'sui-rpc', url: rpcUrl, kind: 'rpc' });
		if (faucetUrl !== undefined) {
			yield* EndpointRegistry.publish({ name: 'sui-faucet', url: faucetUrl, kind: 'faucet' });
		}
		if (graphqlUrl !== undefined) {
			yield* EndpointRegistry.publish({ name: 'sui-graphql', url: graphqlUrl, kind: 'graphql' });
		}
		const chainId = yield* fetchChainId(client);
		return {
			network,
			rpcUrl,
			faucetUrl,
			graphqlUrl,
			client,
			chainId,
		} satisfies SuiShape;
	})();

	const { __layer, key, __kind, __displayTitle } = provideTag(Sui, build, {
		kind: 'service',
		displayTitle: `sui.${options.network ?? 'custom'}`,
		display: (s) => ({ title: `sui.${s.network}`, primary: s.rpcUrl }),
	});
	return { __layer, key, __kind, __displayTitle };
};

// Probe the postgres sidecar with `docker exec <id> pg_isready -U <user>` until
// it reports `accepting connections` (exit 0). Mirrors the retry/timeout shape
// used by `ready-probe.ts`: exponential backoff capped at 2s, total budget 30s.
const indexerDbReadyRetry = Schedule.exponential('100 millis', 1.5).pipe(
	Schedule.either(Schedule.spaced('2 seconds')),
);

const awaitIndexerDbReady = (containerId: string) => {
	const attempt = Effect.gen(function* () {
		const result = yield* Docker.exec(containerId, 'pg_isready', [
			'-U',
			SUI_INDEXER_DB_USER,
			'-d',
			SUI_INDEXER_DB_NAME,
		]).pipe(
			Effect.catchTag('DockerError', (cause) =>
				Effect.fail(
					new SuiError({
						phase: 'indexer-ready',
						message: 'pg_isready exec failed',
						cause,
					}),
				),
			),
		);
		if (result.exitCode !== 0) {
			return yield* Effect.fail(
				new SuiError({
					phase: 'indexer-ready',
					message: `pg_isready exit ${result.exitCode}`,
					stdout: result.stdout,
					stderr: result.stderr,
					exitCode: result.exitCode,
				}),
			);
		}
	});
	return attempt.pipe(
		Effect.retry(indexerDbReadyRetry),
		Effect.timeoutOrElse({
			duration: '30 seconds',
			orElse: () =>
				Effect.fail(
					new SuiError({
						phase: 'indexer-ready',
						message: 'sui indexer-db never became ready within 30s',
					}),
				),
		}),
		Effect.withSpan('sui.indexer-ready'),
	);
};

// Stable throwaway recipient used by the faucet ready-probe. The
// probe POSTs an actual funding request and asserts the response body
// is NOT `status: { Failure }` — see `faucetReadyProbe` below for
// why. Hex bytes are arbitrary; any valid 32-byte Sui address works.
const FAUCET_PROBE_RECIPIENT =
	'0xf0bef0bef0bef0bef0bef0bef0bef0bef0bef0bef0bef0bef0bef0bef0bef0be';

// Faucet ready-probe. POST a real funding request and verify the
// response body is `status: "Success"` (or at least NOT a body-level
// `status: { Failure }`). Exported for unit tests; production callers
// invoke it from `suiLocalnet`'s ready-probe block.
//
// Why this exists: the prior probe checked only `response.ok` (or
// `status < 500`), which passed during the warm-up window where the
// sui-faucet binary's HTTP socket was up but its tx-submission
// pipeline wasn't — the faucet returned 200 OK with body
// `{"status": {"Failure": {"Internal": "..."}}}`. The supervisor
// declared Sui "ready", and downstream `accounts.fund` immediately
// tripped the 90s `requestFunds` timeout because every retry hit the
// same Failure body. Gating ready on a real "no Failure" body means
// Sui isn't marked ready until the faucet can actually fund.
export const faucetReadyProbe = (faucetUrl: string): Effect.Effect<void, Error> =>
	Effect.tryPromise({
		try: async () => {
			const response = await fetch(`${faucetUrl}/v2/gas`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					FixedAmountRequest: { recipient: FAUCET_PROBE_RECIPIENT },
				}),
			});
			if (!response.ok) throw new Error(`faucet HTTP ${response.status}`);
			const body = (await response.json()) as { status?: unknown };
			const status = body.status;
			if (typeof status === 'object' && status !== null && 'Failure' in status) {
				const failure = (status as { Failure: unknown }).Failure;
				throw new Error(`faucet body: Failure ${JSON.stringify(failure)}`);
			}
		},
		catch: (cause) => new Error(`faucet: ${stringifyCause(cause)}`),
	});

// Resolve the chain identifier from a ready-to-talk JSON-RPC client.
// Localnet flips this on `--force-regenesis`; remote networks keep it
// stable. Downstream primitives fold it into their `StateStore` cache
// keys so on-chain artifacts re-derive when the chain underneath them
// is wiped. Annotates the surrounding span for debuggability.
const fetchChainId = (client: SuiJsonRpcClient): Effect.Effect<string, SuiError> =>
	Effect.gen(function* () {
		const chainId = yield* Effect.tryPromise({
			try: () => client.getChainIdentifier(),
			catch: (cause) =>
				new SuiError({
					phase: 'fetch-chainId',
					message: 'failed to fetch chain identifier',
					cause,
				}),
		});
		yield* Effect.annotateCurrentSpan({ 'sui.chainId': chainId });
		return chainId;
	});

