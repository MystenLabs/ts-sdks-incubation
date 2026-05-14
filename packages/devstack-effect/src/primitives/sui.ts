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
import { routerEntrypoint } from '../internal/docker/router.js';
import { Sui, type SuiShape } from '../interfaces/sui.js';
import { stringifyCause } from '../internal/stringify-cause.js';
import { Identity } from '../internal/identity.js';
import { EndpointRegistry } from '../internal/registries.js';
import { routerHostname, routerId } from '../internal/router-hostname.js';
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

// In-container ports the sui binary binds on. Hostname-based routing
// via the shared traefik router means every stack lands on the same
// well-known host port — disambiguation happens by `Host:` header.
// `LOCAL_FAUCET_URL` is still emitted as a fallback for the
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
	/** Faucet base for the externally-managed-RPC branch. Defaults to
	 *  `http://localhost:9123` (the sui binary's conventional faucet port).
	 *  Ignored when `rpcUrl` is not set — the container-boot path always
	 *  embeds its own faucet. */
	readonly faucetUrl?: string;
	/** GraphQL base for the externally-managed-RPC branch. When set,
	 *  surfaced on the `Sui` tag and published to `EndpointRegistry` as
	 *  `sui-graphql`. Left `undefined` by default since there's no stable
	 *  conventional port to probe — pass it explicitly if the upstream
	 *  localnet binary was started with `--with-graphql`. Ignored when
	 *  `rpcUrl` is not set — the container-boot path wires its own
	 *  `--with-graphql=0.0.0.0:9125`. */
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
			const graphqlUrl = options.graphqlUrl;
			const client = new SuiJsonRpcClient({ url: rpcUrl, network: 'localnet' });
			yield* EndpointRegistry.publish({ name: 'sui-rpc', url: rpcUrl, kind: 'rpc' });
			yield* EndpointRegistry.publish({ name: 'sui-faucet', url: faucetUrl, kind: 'faucet' });
			if (graphqlUrl !== undefined) {
				yield* EndpointRegistry.publish({
					name: 'sui-graphql',
					url: graphqlUrl,
					kind: 'graphql',
				});
			}
			const chainId = yield* fetchChainId(client);
			const waitForTransactionsReady = yield* buildWaitForTransactionsReady(faucetUrl);
			return {
				network: 'localnet',
				rpcUrl,
				faucetUrl,
				graphqlUrl,
				client,
				chainId,
				waitForTransactionsReady,
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
		// Hostname-based routing via the shared `devstack-router`
		// (Traefik) container. Each service (rpc/faucet/graphql) lands
		// on a stack-scoped hostname on a fixed well-known entrypoint
		// port (9000 sui-rpc, 9123 sui-faucet, 9125 sui-graphql); the
		// router dispatches by `Host:` header to the right per-stack
		// backend. Two stacks of the same app coexist on the same
		// well-known ports because the hostnames differ
		// (`sui.arena.localhost` vs `test.sui.arena.localhost`).
		//
		// `options.ports` is the rare opt-out: when set the container
		// ALSO publishes direct host ports (in addition to the router
		// path) so callers can dial 127.0.0.1 directly. Per-port
		// allocator usage was removed: no `PortAllocator.allocate` for
		// rpc/faucet/graphql any more.
		const identity = yield* Identity;
		const rpcHostname = routerHostname(identity, 'sui');
		const faucetHostname = routerHostname(identity, 'faucet');
		const graphqlHostname = routerHostname(identity, 'graphql');
		const rpcEntrypointInfo = routerEntrypoint('sui-rpc');
		const faucetEntrypointInfo = routerEntrypoint('sui-faucet');
		const graphqlEntrypointInfo = routerEntrypoint('sui-graphql');
		if (
			rpcEntrypointInfo === undefined ||
			faucetEntrypointInfo === undefined ||
			graphqlEntrypointInfo === undefined
		) {
			return yield* Effect.fail(
				new SuiError({
					phase: 'sui-up',
					message:
						'sui-localnet: router entrypoints sui-rpc/sui-faucet/sui-graphql not registered',
				}),
			);
		}
		const rpcEntrypointPort = rpcEntrypointInfo.port;
		const faucetEntrypointPort = faucetEntrypointInfo.port;
		const graphqlEntrypointPort = graphqlEntrypointInfo.port;
		// Caller-pinned direct host ports (rare opt-out).
		const ports: Record<number, number> | undefined = options.ports;

		// Per-stack docker network — gives the indexer db + sui-localnet
		// stable in-network DNS aliases so the sui process can dial
		// `sui-indexer-db:5432` regardless of host port mapping. Default
		// bridge IPAM is fine: nothing here pins a fixed IP via
		// `Docker.run({ip})`, and a pinned /24 routinely collides with
		// other docker networks on the host (walrus, leftover compose
		// projects). Network name folds in `Identity.stack` so parallel
		// stacks of the same app don't collide on the network; for
		// non-localnet `Identity.network`, a `-${network}` suffix is
		// appended so the same `<app, stack>` against testnet doesn't
		// collide on the bridge network with the same pair against
		// localnet. The `network='localnet'` default keeps the name
		// byte-identical to the pre-network-dimension shape so warm-
		// restart resume still adopts existing networks.
		const suiBase =
			identity.stack === 'main'
				? `${identity.app}-sui-network`
				: `${identity.app}-${identity.stack}-sui-network`;
		const networkName =
			identity.network === 'localnet' ? suiBase : `${suiBase}-${identity.network}`;
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
		// per-(app, stack, network) to match the sui-data volume — the
		// `-${network}` suffix is only appended for non-localnet so the
		// default name stays byte-identical for warm-restart resume.
		const indexerDbBase =
			identity.stack === 'main'
				? `devstack-${identity.app}-sui-indexer-db`
				: `devstack-${identity.app}-${identity.stack}-sui-indexer-db`;
		const indexerDbVolume =
			identity.network === 'localnet' ? indexerDbBase : `${indexerDbBase}-${identity.network}`;
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
		// `pnpm dev`. Volume name is per-(app, stack, network) so two stacks
		// of the same app don't share genesis, and switching `network`
		// (e.g. localnet → testnet) doesn't accidentally reuse the
		// localnet's chain state. `localnet` is the byte-identical default
		// so warm-restart resume still finds the existing volume.
		// `devstack wipe` removes this volume alongside the containers.
		const suiDataBase =
			identity.stack === 'main'
				? `devstack-${identity.app}-sui-data`
				: `devstack-${identity.app}-${identity.stack}-sui-data`;
		const suiDataVolume =
			identity.network === 'localnet' ? suiDataBase : `${suiDataBase}-${identity.network}`;
		yield* setPhase('starting localnet');
		const localnetRunResult = yield* Docker.run({
			name: 'sui.localnet',
			image,
			args: [
				'start',
				'--with-faucet=0.0.0.0:9123',
				`--with-indexer=${SUI_INDEXER_DATABASE_URL}`,
				'--with-graphql=0.0.0.0:9125',
			],
			// Direct host-port publishing only when the caller pins
			// `options.ports`. The default path leaves it undefined so
			// the container relies entirely on the router for external
			// reachability — two stacks of the same app then never fight
			// for the host's 9000/9123/9125.
			...(ports !== undefined ? { ports } : {}),
			network: networkName,
			networkAlias: SUI_LOCALNET_NETWORK_ALIAS,
			mounts: [{ host: suiDataVolume, container: '/root/.sui' }],
			detach: true,
			// One traefik router entry per service (rpc/faucet/graphql).
			// `id` is `<app>-<stack>-<service>` so two stacks of the same
			// app produce disjoint label sets; `entrypoint` matches the
			// well-known router entrypoint name; `servicePort` is the
			// container-internal port the sui binary binds on.
			traefik: [
				{
					id: routerId(identity, 'sui-rpc'),
					hostname: rpcHostname,
					entrypoint: 'sui-rpc',
					servicePort: LOCAL_RPC_PORT,
				},
				{
					id: routerId(identity, 'sui-faucet'),
					hostname: faucetHostname,
					entrypoint: 'sui-faucet',
					servicePort: LOCAL_FAUCET_PORT,
				},
				{
					id: routerId(identity, 'sui-graphql'),
					hostname: graphqlHostname,
					entrypoint: 'sui-graphql',
					servicePort: LOCAL_GRAPHQL_PORT,
				},
			],
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
		void localnetRunResult;

		// SDK-facing URLs go through the shared Traefik router on the
		// well-known entrypoint ports. The `Host:` header (set by every
		// HTTP client that dials `http://sui.<app>.localhost:9000`) is
		// what tells traefik which per-stack backend to forward to.
		const rpcUrl = `http://${rpcHostname}:${rpcEntrypointPort}`;
		const faucetUrl = `http://${faucetHostname}:${faucetEntrypointPort}`;
		const graphqlUrl = `http://${graphqlHostname}:${graphqlEntrypointPort}/graphql`;
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
		// Ready when the HTTP sockets are bound. The faucet binary may
		// still be warming up (returning 200 OK with body-level
		// `{"status": {"Failure": ...}}` for ~30s after cold genesis),
		// but `requestFunds` in `internal/faucet.ts` already parses the
		// body and retries on `Failure` through a 90s budget — that's
		// where the warm-up race gets absorbed. Gating Sui-ready on a
		// real funding tx (the previous attempt) added ~30s to every
		// cold restart without any correctness benefit, since
		// `accounts.fund` was already covering the same ground.
		const readyTimeoutMs = options.readyTimeoutMs ?? 60_000;
		// Per-fetch timeout via AbortSignal — without it a hung fetch
		// (firewall drops, container in a weird half-listen state)
		// blocks the whole `Effect.all` until the outer 60s timeout
		// fires, with no signal about which probe was the laggard.
		// 3s per attempt is plenty for a localhost HTTP round-trip;
		// the retry loop picks back up immediately on failure.
		const PROBE_FETCH_TIMEOUT_MS = 3000;
		const probeFetch = (url: string, init: RequestInit) =>
			fetch(url, { ...init, signal: AbortSignal.timeout(PROBE_FETCH_TIMEOUT_MS) });

		// Track which probe last succeeded so the timeout error names
		// the laggard. Hidden refs via closure since the probes already
		// run inside the same Effect.gen.
		const probeStatus: { rpc: boolean; faucet: boolean; graphql: boolean } = {
			rpc: false,
			faucet: false,
			graphql: false,
		};
		const rpcProbe = Effect.tryPromise({
			try: () => client.getChainIdentifier(),
			catch: (cause) => new Error(`rpc: ${stringifyCause(cause)}`),
		}).pipe(
			Effect.tap(() => Effect.sync(() => (probeStatus.rpc = true))),
			Effect.withSpan('sui.probe.rpc'),
		);
		// Cheap socket-level liveness check. We deliberately do NOT
		// POST `/v2/gas` here — that path actually transfers SUI from
		// the dispenser and can block for many seconds during startup
		// while the validator hasn't produced a checkpoint yet. Hitting
		// `GET /` returns "OK" as soon as the HTTP server is bound and
		// proves the faucet is up without consuming gas or stalling on
		// chain state.
		const faucetProbe = Effect.tryPromise({
			try: async () => {
				const r = await probeFetch(faucetUrl, { method: 'GET' });
				if (r.status >= 500) throw new Error(`faucet: ${r.status}`);
			},
			catch: (cause) => new Error(`faucet: ${stringifyCause(cause)}`),
		}).pipe(
			Effect.tap(() => Effect.sync(() => (probeStatus.faucet = true))),
			Effect.withSpan('sui.probe.faucet'),
		);
		const graphqlProbe = Effect.tryPromise({
			try: () =>
				probeFetch(graphqlUrl, {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ query: '{ chainIdentifier }' }),
				}).then((r) => {
					if (!r.ok) throw new Error(`graphql: ${r.status}`);
				}),
			catch: (cause) => new Error(`graphql: ${stringifyCause(cause)}`),
		}).pipe(
			Effect.tap(() => Effect.sync(() => (probeStatus.graphql = true))),
			Effect.withSpan('sui.probe.graphql'),
		);
		yield* Effect.all([rpcProbe, faucetProbe, graphqlProbe], {
			concurrency: 'unbounded',
		}).pipe(
			Effect.retry(Schedule.spaced('1 seconds')),
			Effect.timeoutOrElse({
				duration: `${readyTimeoutMs} millis`,
				orElse: () =>
					// On timeout, fetch the sui-localnet container's log
					// tail so the resulting error names a real cause
					// (genesis crash, port-bind clash inside the
					// container, indexer DB connection failure, …)
					// instead of a generic "did not become ready".
					Docker.dockerLogsTail(localnetRunResult.name).pipe(
						Effect.flatMap((tail) => {
							const stillFailing = (['rpc', 'faucet', 'graphql'] as const).filter(
								(k) => !probeStatus[k],
							);
							const lagSummary =
								stillFailing.length === 0
									? 'all three probes succeeded at least once individually but never together'
									: `never-succeeded: ${stillFailing.join(', ')}`;
							return Effect.fail(
								new SuiError({
									phase: 'ready-probe',
									message: `sui localnet did not become fully ready within ${readyTimeoutMs}ms (rpc=${probeStatus.rpc} faucet=${probeStatus.faucet} graphql=${probeStatus.graphql}); ${lagSummary}; sui-rpc=${rpcUrl} faucet=${faucetUrl} graphql=${graphqlUrl}`,
									stderr: tail.length > 0 ? tail : undefined,
								}),
							);
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
		const waitForTransactionsReady = yield* buildWaitForTransactionsReady(faucetUrl);

		return {
			network: 'localnet',
			rpcUrl,
			faucetUrl,
			graphqlUrl,
			client,
			chainId,
			waitForTransactionsReady,
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
		const waitForTransactionsReady = yield* buildWaitForTransactionsReady(faucetUrl);
		return {
			network: 'testnet',
			rpcUrl,
			faucetUrl,
			graphqlUrl,
			client,
			chainId,
			waitForTransactionsReady,
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
		// Mainnet has no faucet — the chain is presumed always-transferable
		// (any caller submitting a tx on mainnet brought their own gas).
		const waitForTransactionsReady = yield* buildWaitForTransactionsReady(undefined);
		return {
			network: 'mainnet',
			rpcUrl,
			faucetUrl: undefined,
			graphqlUrl,
			client,
			chainId,
			waitForTransactionsReady,
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
		const waitForTransactionsReady = yield* buildWaitForTransactionsReady(faucetUrl);
		return {
			network,
			rpcUrl,
			faucetUrl,
			graphqlUrl,
			client,
			chainId,
			waitForTransactionsReady,
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
const FAUCET_PROBE_RECIPIENT = '0xf0bef0bef0bef0bef0bef0bef0bef0bef0bef0bef0bef0bef0bef0bef0bef0be';

// Faucet ready-probe. POST a real funding request and verify the
// response body is `status: "Success"` (or at least NOT a body-level
// `status: { Failure }`). Exported for unit tests; production callers
// invoke it via the `waitForTransactionsReady` method on `SuiShape`
// (see `makeWaitForTransactionsReady` below), which wraps this in a
// retry/timeout budget and maps the rejection into a typed `SuiError`.
//
// Why this exists: the supervisor's Sui-ready gate is socket-level
// only (`GET /` to faucet, `getChainIdentifier()` for RPC, a `{
// chainIdentifier }` GraphQL POST). Those pass as soon as the HTTP
// servers are bound — typically a beat BEFORE the underlying validator
// has produced a checkpoint, during which the faucet returns 200 OK
// with body `{"status": {"Failure": {"Internal": "..."}}}` for any
// real funding request. Primitives that immediately submit a
// funds-transferable tx after yielding `Sui` need a stronger guarantee
// than socket-level liveness; this probe upgrades that guarantee by
// pinging the faucet's actual tx pipeline.
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

// Per-attempt and total budget for the `waitForTransactionsReady`
// retry loop. The 5s spacing matches the upstream sui-faucet binary's
// internal retry cadence; the 90s total budget matches the existing
// `requestFunds` wall-clock in `internal/faucet.ts` — by the time
// THAT timeout would fire, this probe will already have exhausted its
// own budget and surfaced a more specific error.
const WAIT_FOR_TX_READY_RETRY_SPACING = '2 seconds';
const WAIT_FOR_TX_READY_TIMEOUT_MS = 90_000;

/**
 * Build an `Effect<void, SuiError>` that resolves when the chain
 * underlying `faucetUrl` is actually transferring funds (i.e. the
 * faucet's `/v2/gas` POST stops returning body-level `Failure`).
 * Internal — every `Sui*` factory wraps it in `Effect.cached` so
 * repeated `waitForTransactionsReady()` calls reuse the first
 * success. Callers without a faucet (mainnet, suiCustom without one)
 * get `Effect.void` instead — see the call sites in `suiLocalnet`,
 * `suiTestnet`, `suiMainnet`, and `suiCustom`.
 */
const makeWaitForTransactionsReadyForFaucet = (faucetUrl: string): Effect.Effect<void, SuiError> =>
	faucetReadyProbe(faucetUrl).pipe(
		Effect.retry(Schedule.spaced(WAIT_FOR_TX_READY_RETRY_SPACING)),
		Effect.timeoutOrElse({
			duration: `${WAIT_FOR_TX_READY_TIMEOUT_MS} millis`,
			orElse: () =>
				Effect.fail(
					new SuiError({
						phase: 'wait-for-transactions-ready',
						message:
							`sui faucet at ${faucetUrl} did not become funds-transferable within ` +
							`${WAIT_FOR_TX_READY_TIMEOUT_MS}ms (still returning body-level Failure or ` +
							`5xx). The HTTP socket is bound but the underlying validator can't yet ` +
							`accept funding txs — usually a chain still mid-genesis.`,
					}),
				),
		}),
		Effect.mapError((cause) =>
			cause instanceof SuiError
				? cause
				: new SuiError({
						phase: 'wait-for-transactions-ready',
						message: `sui faucet at ${faucetUrl} probe failed: ${cause.message}`,
						cause,
					}),
		),
		Effect.withSpan('sui.waitForTransactionsReady'),
	);

/**
 * Yields a memoized `waitForTransactionsReady` closure to embed in
 * the returned `SuiShape`. Memoization makes repeat calls cheap — the
 * first call pays the retry budget, every subsequent call sees a
 * resolved cache. Networks without a faucet (mainnet, suiCustom
 * without `faucetUrl`) get a no-op since the chain is presumed
 * always-transferable on those surfaces; callers that need a real
 * guarantee on a corporate fork should pin a `faucetUrl` explicitly.
 */
const buildWaitForTransactionsReady = (
	faucetUrl: string | undefined,
): Effect.Effect<() => Effect.Effect<void, SuiError>> =>
	Effect.gen(function* () {
		if (faucetUrl === undefined) {
			// No faucet — the chain is presumed always-transferable (mainnet
			// reads, corporate fork without funding flows). Callers that
			// need a stronger guarantee should pin a faucetUrl.
			return () => Effect.void;
		}
		const cached = yield* Effect.cached(makeWaitForTransactionsReadyForFaucet(faucetUrl));
		return () => cached;
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
