// Sui(opts?) — the canonical sui factory.
//
// Collapses four network sources behind one entry. Default is localnet
// (vendored image with embedded faucet + indexer postgres + GraphQL);
// `network: 'testnet'`/`'mainnet'` give RPC-only handles to the public
// fullnodes; `network: { rpc, faucet? }` is the escape hatch for custom
// RPCs (corporate fullnodes, pinned forks, air-gapped mirrors).
//
// This file also carries the canonical `SuiTag` Context.Service tag
// (Phase 4), the `SuiNetwork` literal alias used across the engine, the
// `suiNetworkName` helper used by walrus + seal container-joining
// primitives, and the `faucetReadyProbe` that gates funds-transferable
// readiness on localnet.

import { Context, Effect, Layer, Schedule, Schema } from 'effect';
import { SuiJsonRpcClient } from '@mysten/sui/jsonRpc';
import * as Docker from '../engine/docker.js';
import { routerEntrypoint } from '../engine/docker/router.js';
import type { Endpoint } from '../engine/endpoint.js';
import { stringifyCause } from '../engine/stringify-cause.js';
import { Identity } from '../engine/identity.js';
import { EndpointRegistry } from '../engine/registries.js';
import { routerHostname, routerId } from '../engine/router-hostname.js';
import { SuiBuildImage } from '../engine/sui-cli.js';
import { SuiBuildContainerLive } from '../engine/sui-build-container.js';
import { dockerImage } from '../advanced/plugin-author/index.js';
import { provide, setPhase, type Ref } from '../advanced/tag.js';
import type { StackMember } from '../engine/supervisor.js';
import { SuiError } from '../engine/errors.js';
import { resolveNetwork } from '../engine/network.js';

// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------

/** Pinned upstream Sui release. The `sui-image/` Dockerfile downloads
 *  the matching `ubuntu-aarch64` / `ubuntu-x86_64` tarball at build time
 *  so the resulting image runs natively on the host architecture —
 *  `mysten/sui-tools` ships amd64 only, which forces Rosetta emulation
 *  on Apple Silicon and stretches `sui start` genesis from ~10 s to 5+
 *  minutes. Bump in lockstep with the matching walrus / seal versions
 *  (or the Move package ABIs drift). */
const DEFAULT_SUI_VERSION = 'devnet-v1.71.0';

// In-container ports the sui binary binds on. Hostname-based routing
// via the shared traefik router means every stack lands on the same
// well-known host port — disambiguation happens by `Host:` header.
const LOCAL_RPC_PORT = 9000;
const LOCAL_FAUCET_PORT = 9123;
const LOCAL_GRAPHQL_PORT = 9125;

// Postgres sidecar that backs `sui start --with-indexer`'s database.
// The sui CLI requires a real postgres URL — there's no embedded
// option — so we run a postgres container on the same per-stack docker
// network. Only the sui process talks to it (via the in-network alias);
// no host port mapping.
//
// The image is built from `packages/devstack/postgres-image/Dockerfile`
// (Phase 2.2 of the snapshot redesign) — upstream postgres declares
// `VOLUME /var/lib/postgresql/data`, which docker excludes from
// `docker commit`. The vendored Dockerfile relocates PGDATA to
// `/pgdata` (off the inherited VOLUME) so the indexer's schema + rows
// land in the writable layer and ride snapshots correctly.
const SUI_INDEXER_DB_BASE_VERSION = '16-alpine';
const SUI_INDEXER_DB_NETWORK_ALIAS = 'sui-indexer-db';
const SUI_LOCALNET_NETWORK_ALIAS = 'sui-localnet';
const SUI_INDEXER_DB_USER = 'sui';
const SUI_INDEXER_DB_PASSWORD = 'sui';
const SUI_INDEXER_DB_NAME = 'sui_indexer';
const SUI_INDEXER_DATABASE_URL = `postgres://${SUI_INDEXER_DB_USER}:${SUI_INDEXER_DB_PASSWORD}@${SUI_INDEXER_DB_NETWORK_ALIAS}:5432/${SUI_INDEXER_DB_NAME}`;

// In-container ports the sui binary binds on inside the localnet image.
// Consumers that join the sui per-stack docker network dial sui-localnet
// directly using the `sui-localnet` DNS alias; the routed `*.localhost`
// URLs are reserved for host-side traffic (glibc bypasses /etc/hosts
// for `.localhost`, so routed URLs are unreachable inside a glibc
// container).
const INTERNAL_RPC_URL = `http://${SUI_LOCALNET_NETWORK_ALIAS}:${LOCAL_RPC_PORT}`;
const INTERNAL_FAUCET_URL = `http://${SUI_LOCALNET_NETWORK_ALIAS}:${LOCAL_FAUCET_PORT}`;
const INTERNAL_GRAPHQL_URL = `http://${SUI_LOCALNET_NETWORK_ALIAS}:${LOCAL_GRAPHQL_PORT}/graphql`;

// -----------------------------------------------------------------------------
// Contract
// -----------------------------------------------------------------------------

/** Three-network literal alias used by engine / state-store / supervisor.
 *  Exported because those callers fold the value into per-network cache
 *  paths + warm-restart resume keys. */
export type SuiNetwork = 'localnet' | 'testnet' | 'mainnet';

/** Shape every Sui-producing factory must satisfy.
 *
 *  - `network` accepts the well-known names plus an open string so
 *    bespoke chains (e.g. a pinned devnet snapshot, a tenant-specific
 *    fork) typecheck without losing literal narrowing on the common
 *    case.
 *  - `rpc` / `faucet` / `graphql` are `Endpoint`s carrying BOTH a
 *    host-reachable URL and (when meaningful) a docker-DNS URL plus
 *    the per-stack networks on which the docker-DNS form resolves.
 *    Host-side callers (browser, supervisor, host-CLI invocations)
 *    read `.host`; container-side callers (one-shot scripts, key-
 *    server config files, walrus storage-node env) read `.container`
 *    and attach to one of `.containerNetworks`.
 *  - `faucet` is optional because mainnet has no faucet and testnet's
 *    faucet may be unreachable in restricted networks; localnet always
 *    surfaces one.
 *  - `chainId` is the checkpoint-0 digest; downstream primitives fold it
 *    into their `StateStore` cache keys so artifacts re-derive when the
 *    chain underneath them is wiped.
 *  - `waitForTransactionsReady` upgrades the socket-level "ready" the
 *    Sui factory declares (RPC + faucet + GraphQL all listening) into
 *    a "the chain can actually transfer funds" guarantee. Any caller
 *    that immediately submits a funds-transferable tx after yielding
 *    `SuiTag` (faucet POSTs, signed transfers, package publishes) must
 *    call this method first. Resolves immediately on networks without a
 *    faucet (mainnet, suiCustom without `faucet`) where the chain is
 *    presumed always-transferable by definition. */
export interface Sui {
	readonly network: 'localnet' | 'testnet' | 'mainnet' | 'devnet' | (string & {});
	readonly rpc: Endpoint;
	readonly faucet?: Endpoint;
	readonly graphql?: Endpoint;
	readonly client: SuiJsonRpcClient;
	readonly chainId: string;
	readonly waitForTransactionsReady: () => Effect.Effect<void, SuiError>;
	/**
	 * Discriminator for the runtime shape of the chain backing this Sui.
	 * `'bundled'` = the vendored sui-localnet container devstack starts
	 * (full control over genesis + chain id + indexer); `'external'` =
	 * a user-supplied RPC (any chain id, no docker control, no
	 * indexer assumptions). `network` stays at the user's configured
	 * value (`'localnet'` even when wrapping an external RPC) so
	 * KnownPackage / dapp-kit network-name lookups behave consistently;
	 * downstream policy that needs to know "are we running a real
	 * localnet container?" branches on `runtime` instead. HIGH-T4.
	 */
	readonly runtime: 'bundled' | 'external';
}

/** Canonical Sui service tag. Named `SuiTag` (not `Sui`) so the factory
 *  `Sui(opts?)` in this file can take the public-surface name. The
 *  Context key (`'@devstack/Sui'`) is unchanged, so any layer keyed
 *  against the legacy `Sui` class identity continues to resolve. */
export class SuiTag extends Context.Service<SuiTag, Sui>()('@devstack/Sui') {}

/** Runtime-validation mirror of `Endpoint`. Used by `SuiSchema`. */
export const EndpointSchema = Schema.Struct({
	host: Schema.String,
	container: Schema.optional(Schema.String),
	containerNetworks: Schema.optional(Schema.Array(Schema.String)),
});

/** Runtime-validation mirror of `Sui`. Use
 *  `Schema.decode(SuiSchema)` to validate a hand-rolled
 *  `Layer.succeed(SuiTag, ...)`. `client` and `waitForTransactionsReady`
 *  are closures / live objects so they're typed as `Unknown`. */
export const SuiSchema = Schema.Struct({
	network: Schema.String,
	rpc: EndpointSchema,
	faucet: Schema.optional(EndpointSchema),
	graphql: Schema.optional(EndpointSchema),
	chainId: Schema.String,
	client: Schema.Unknown,
	waitForTransactionsReady: Schema.Unknown,
});

// -----------------------------------------------------------------------------
// Public helpers
// -----------------------------------------------------------------------------

/**
 * Per-stack docker network name used by the localnet build path. Exported
 * so downstream container-side consumers (walrus deploy / nodes, seal
 * key-server) can join the same network and resolve `sui-localnet` via
 * docker DNS.
 */
export const suiNetworkName = (identity: {
	readonly app: string;
	readonly stack: string;
	readonly network: string;
}): string => {
	const base =
		identity.stack === 'main'
			? `${identity.app}-sui-network`
			: `${identity.app}-${identity.stack}-sui-network`;
	return identity.network === 'localnet' ? base : `${base}-${identity.network}`;
};

// Stable throwaway recipient used by the faucet ready-probe. The probe
// POSTs an actual funding request and asserts the response body is NOT
// `status: { Failure }`. Hex bytes are arbitrary; any valid 32-byte Sui
// address works.
const FAUCET_PROBE_RECIPIENT = '0xf0bef0bef0bef0bef0bef0bef0bef0bef0bef0bef0bef0bef0bef0bef0bef0be';

/**
 * Faucet ready-probe. POST a real funding request and verify the
 * response body is `status: "Success"` (or at least NOT a body-level
 * `status: { Failure }`). Exported for unit tests; production callers
 * invoke it via the `waitForTransactionsReady` method on `Sui`,
 * which wraps this in a retry/timeout budget and maps the rejection
 * into a typed `SuiError`.
 *
 * Why this exists: the supervisor's Sui-ready gate is socket-level
 * only (`GET /` to faucet, `getChainIdentifier()` for RPC, a `{
 * chainIdentifier }` GraphQL POST). Those pass as soon as the HTTP
 * servers are bound — typically a beat BEFORE the underlying validator
 * has produced a checkpoint, during which the faucet returns 200 OK
 * with body `{"status": {"Failure": {"Internal": "..."}}}` for any
 * real funding request. Primitives that immediately submit a
 * funds-transferable tx after yielding `SuiTag` need a stronger
 * guarantee than socket-level liveness; this probe upgrades that
 * guarantee by pinging the faucet's actual tx pipeline.
 */
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
// retry loop. The 2s spacing matches the upstream sui-faucet binary's
// internal retry cadence; the 90s total budget matches the existing
// `requestFunds` wall-clock in `engine/faucet.ts`.
const WAIT_FOR_TX_READY_RETRY_SPACING = '2 seconds';
const WAIT_FOR_TX_READY_TIMEOUT_MS = 90_000;

const makeWaitForTransactionsReadyForFaucet = (
	faucetUrl: string,
): Effect.Effect<void, SuiError> =>
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

const buildWaitForTransactionsReady = (
	faucetUrl: string | undefined,
): Effect.Effect<() => Effect.Effect<void, SuiError>> =>
	Effect.gen(function* () {
		if (faucetUrl === undefined) {
			// No faucet — the chain is presumed always-transferable (mainnet
			// reads, corporate fork without funding flows).
			return () => Effect.void;
		}
		const cached = yield* Effect.cached(makeWaitForTransactionsReadyForFaucet(faucetUrl));
		return () => cached;
	});

// Resolve the chain identifier from a ready-to-talk JSON-RPC client.
// Downstream primitives fold this into their `StateStore` cache keys so
// on-chain artifacts re-derive when the chain underneath them is wiped.
//
// 30s wall-clock budget: a healthy localnet RPC responds in <1s and
// a public testnet/mainnet endpoint in <5s. A wedged RPC (DNS hang,
// connection-stuck-on-SYN) would otherwise block supervisor boot
// indefinitely; failing at 30s surfaces as a typed `SuiError` whose
// message is actionable instead of an inscrutable hang.
const FETCH_CHAIN_ID_TIMEOUT_MS = 30_000;
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
		}).pipe(
			Effect.timeoutOrElse({
				duration: `${FETCH_CHAIN_ID_TIMEOUT_MS} millis`,
				orElse: () =>
					Effect.fail(
						new SuiError({
							phase: 'fetch-chainId',
							message: `fetchChainId timed out after ${FETCH_CHAIN_ID_TIMEOUT_MS}ms; the RPC may be unreachable or wedged`,
						}),
					),
			}),
		);
		yield* Effect.annotateCurrentSpan({ 'sui.chainId': chainId });
		return chainId;
	});

// Probe the postgres sidecar with `docker exec <id> pg_isready -U <user>`
// until it reports `accepting connections` (exit 0). Exponential backoff
// capped at 2s, total budget 30s.
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

// -----------------------------------------------------------------------------
// Factory option types
// -----------------------------------------------------------------------------

/** Localnet-specific knobs. Pass via `Sui({ localnet: {...} })`. */
export interface SuiLocalnetOptions {
	/** Pre-built image reference (e.g. a locally-built arm64 tag or an
	 *  air-gapped mirror). When set, `version` is ignored and the
	 *  vendored `sui-image/` build is skipped. */
	readonly image?: string;
	/** Sui release tag passed as `SUI_VERSION` to the vendored
	 *  `sui-image/` Dockerfile. */
	readonly version?: string;
	/** Pre-existing RPC base. When set, the localnet branch skips the
	 *  container body and just wraps an externally-managed localnet. */
	readonly rpcUrl?: string;
	/** Faucet base for the externally-managed-RPC branch. Defaults to
	 *  `http://localhost:9123`. Ignored when `rpcUrl` is not set — the
	 *  container-boot path always embeds its own faucet. */
	readonly faucetUrl?: string;
	/** GraphQL base for the externally-managed-RPC branch. */
	readonly graphqlUrl?: string;
	readonly ports?: Readonly<Record<number, number>>;
	readonly readyTimeoutMs?: number;
}

/** Testnet-specific knobs. Pass via `Sui({ network: 'testnet', testnet: {...} })`. */
export interface SuiTestnetOptions {
	readonly rpcUrl?: string;
	readonly faucetUrl?: string;
	readonly graphqlUrl?: string;
}

/** Mainnet-specific knobs. Pass via `Sui({ network: 'mainnet', mainnet: {...} })`. */
export interface SuiMainnetOptions {
	readonly rpcUrl?: string;
	readonly graphqlUrl?: string;
}

/** Custom-network knobs. Used when `Sui({ network: { rpc, faucet?, graphql?, label? } })`. */
export interface SuiCustomOptions {
	readonly rpcUrl: string;
	readonly faucetUrl?: string;
	readonly graphqlUrl?: string;
	/** Free-form network label (e.g. `'corp-fork'`, `'devnet-pin'`). */
	readonly network?: string;
}

export interface SuiOptions {
	/** Which sui network to provide. Defaults to `'localnet'`, which
	 *  spins up a local sui-test-validator container with embedded
	 *  faucet + GraphQL. `'testnet'`/`'mainnet'` produce RPC-only
	 *  handles pointing at the public fullnodes. Pass an object form
	 *  (`{ rpc, faucet? }`) for custom RPC endpoints (corporate fullnodes,
	 *  pinned forks, air-gapped mirrors). */
	readonly network?:
		| 'localnet'
		| 'testnet'
		| 'mainnet'
		| { readonly rpc: string; readonly faucet?: string };

	/** Pass-through extras for the localnet variant. Ignored on testnet /
	 *  mainnet / custom. */
	readonly localnet?: SuiLocalnetOptions;
	/** Pass-through extras for testnet. */
	readonly testnet?: SuiTestnetOptions;
	/** Pass-through extras for mainnet. */
	readonly mainnet?: SuiMainnetOptions;
}

// -----------------------------------------------------------------------------
// Per-network builders. Module-private — call sites flow through Sui().
// -----------------------------------------------------------------------------

const buildLocalnet = (options: SuiLocalnetOptions): StackMember => {
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

	// Sibling tag for the indexer-db postgres image. Vendored Dockerfile
	// in `postgres-image/` overrides `PGDATA` to `/pgdata` so the writable
	// layer captures the indexer schema + row data (the upstream
	// `postgres:*` image declares VOLUME on the default PGDATA, which
	// `docker commit` excludes). Built lazily — only when the sui
	// primitive actually starts an indexer (i.e. always, today; the
	// option to skip the indexer entirely is a future-proofing path).
	const indexerDbContext = new URL('../../postgres-image/', import.meta.url).pathname;
	const indexerDbImage = dockerImage({
		name: 'sui.indexer-db.image',
		build: {
			context: indexerDbContext,
			dockerfile: 'Dockerfile',
			buildArgs: { POSTGRES_VERSION: SUI_INDEXER_DB_BASE_VERSION },
		},
	});

	const build = Effect.fn('suiLocalnet')(function* () {
		// Localnet with externally-managed RPC. Caller pre-booted their own
		// sui-localnet (and possibly faucet / graphql) and asks devstack to
		// just wrap it. We surface only the endpoints they supplied — no
		// fabricated default-faucet URL, no chain-ready probe against a
		// faucet they may not have.
		if (options.rpcUrl !== undefined) {
			const rpcUrl = options.rpcUrl;
			const faucetUrl = options.faucetUrl;
			const graphqlUrl = options.graphqlUrl;
			const client = new SuiJsonRpcClient({ url: rpcUrl, network: 'localnet' });
			yield* EndpointRegistry.publish({ name: 'sui-rpc', url: rpcUrl, kind: 'rpc' });
			if (faucetUrl !== undefined) {
				yield* EndpointRegistry.publish({
					name: 'sui-faucet',
					url: faucetUrl,
					kind: 'faucet',
				});
			}
			if (graphqlUrl !== undefined) {
				yield* EndpointRegistry.publish({
					name: 'sui-graphql',
					url: graphqlUrl,
					kind: 'graphql',
				});
			}
			const chainId = yield* fetchChainId(client);
			const waitForTransactionsReady =
				faucetUrl !== undefined
					? yield* buildWaitForTransactionsReady(faucetUrl)
					: () => Effect.void;
			// Externally-managed RPC: no per-stack docker network, no
			// container-side URL on any endpoint.
			const rpc: Endpoint = { host: rpcUrl };
			const faucet: Endpoint | undefined =
				faucetUrl !== undefined ? { host: faucetUrl } : undefined;
			const graphql: Endpoint | undefined =
				graphqlUrl !== undefined ? { host: graphqlUrl } : undefined;
			return {
				network: 'localnet',
				rpc,
				...(faucet !== undefined ? { faucet } : {}),
				...(graphql !== undefined ? { graphql } : {}),
				client,
				chainId,
				waitForTransactionsReady,
				runtime: 'external',
			} satisfies Sui;
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
		// Hostname-based routing via the shared `devstack-router` (Traefik)
		// container. Each service (rpc/faucet/graphql) lands on a
		// stack-scoped hostname on a fixed well-known entrypoint port (9000
		// sui-rpc, 9123 sui-faucet, 9125 sui-graphql); the router
		// dispatches by `Host:` header to the right per-stack backend.
		//
		// `options.ports` is the rare opt-out: when set the container ALSO
		// publishes direct host ports (in addition to the router path).
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
		// stable in-network DNS aliases. Default bridge IPAM is fine.
		// Network name folds in `Identity.stack` so parallel stacks of the
		// same app don't collide; non-localnet networks get a suffix.
		const networkName = suiNetworkName(identity);
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

		// Postgres sidecar — internal only, no host port mapping. Indexer
		// state (schema + rows) lives in the writable layer at `/pgdata`
		// (the vendored Dockerfile relocates PGDATA off the upstream
		// VOLUME, so `docker commit` captures it for snapshots). Cycle
		// teardown via `docker stop` keeps the layer for the next `up` to
		// resume. Old per-(app, stack) named volumes from the pre-Phase-2
		// layout are swept by `devstack wipe`.
		const indexerDbImageTag = yield* indexerDbImage;
		yield* setPhase('starting indexer-db');
		const indexerDb = yield* Docker.run({
			name: 'sui.indexer-db',
			image: indexerDbImageTag.tag,
			env: {
				POSTGRES_USER: SUI_INDEXER_DB_USER,
				POSTGRES_PASSWORD: SUI_INDEXER_DB_PASSWORD,
				POSTGRES_DB: SUI_INDEXER_DB_NAME,
			},
			network: networkName,
			networkAlias: SUI_INDEXER_DB_NETWORK_ALIAS,
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

		// Chain state lives in the writable layer at `/root/.sui`.
		// Pre-Phase 2 this was a named volume (`devstack-<app>-sui-data`)
		// so `docker rm` would preserve state — but volumes are excluded
		// from `docker commit`, breaking the snapshot capture surface.
		// Now: `docker stop` on cycle teardown keeps the writable layer
		// for the next `up` to resume via the reuse-if-image-matches probe
		// (~1s warm start), and `docker commit` of the running container
		// captures chain state in full for `devstack snapshot save`.
		// `wipe` still cleans up old per-stack volumes if they exist from
		// the previous layout.
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
			...(ports !== undefined ? { ports } : {}),
			network: networkName,
			networkAlias: SUI_LOCALNET_NETWORK_ALIAS,
			detach: true,
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
		// well-known entrypoint ports.
		const rpcUrl = `http://${rpcHostname}:${rpcEntrypointPort}`;
		const faucetUrl = `http://${faucetHostname}:${faucetEntrypointPort}`;
		const graphqlUrl = `http://${graphqlHostname}:${graphqlEntrypointPort}/graphql`;
		const client = new SuiJsonRpcClient({ url: rpcUrl, network: 'localnet' });

		// Gate `SuiTag` readiness on ALL three endpoints actually serving:
		//   - JSON-RPC: real method call (bare GET returns 405)
		//   - Faucet: GET `/` (socket-level — actual `/v2/gas` would consume gas)
		//   - GraphQL: POST `{ chainIdentifier }` against /graphql
		yield* setPhase('awaiting rpc + faucet + graphql');
		const readyTimeoutMs = options.readyTimeoutMs ?? 60_000;
		// Per-fetch timeout via AbortSignal — without it a hung fetch
		// blocks the whole `Effect.all` until the outer 60s timeout
		// fires, with no signal about which probe was the laggard.
		const PROBE_FETCH_TIMEOUT_MS = 3000;
		const probeFetch = (url: string, init: RequestInit) =>
			fetch(url, { ...init, signal: AbortSignal.timeout(PROBE_FETCH_TIMEOUT_MS) });

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
		// Cheap socket-level liveness check. We deliberately do NOT POST
		// `/v2/gas` here — that path actually transfers SUI from the
		// dispenser and can block for many seconds during startup while
		// the validator hasn't produced a checkpoint yet. Hitting `GET /`
		// returns "OK" as soon as the HTTP server is bound.
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
		yield* EndpointRegistry.publish({
			name: 'sui-indexer-db',
			url: SUI_INDEXER_DATABASE_URL,
			kind: 'internal',
		});

		const chainId = yield* fetchChainId(client);
		const waitForTransactionsReady = yield* buildWaitForTransactionsReady(faucetUrl);

		// Endpoints carry both the routed host URL and the docker-DNS
		// container URL. Containers that need to dial sui from inside
		// the docker engine join `networkName` and resolve `sui-localnet`
		// via docker DNS — bypassing `.localhost`'s host-only RFC 6761
		// resolution that glibc-based containers don't honor.
		const rpc: Endpoint = {
			host: rpcUrl,
			container: INTERNAL_RPC_URL,
			containerNetworks: [networkName],
		};
		const faucet: Endpoint = {
			host: faucetUrl,
			container: INTERNAL_FAUCET_URL,
			containerNetworks: [networkName],
		};
		const graphql: Endpoint = {
			host: graphqlUrl,
			container: INTERNAL_GRAPHQL_URL,
			containerNetworks: [networkName],
		};

		return {
			network: 'localnet',
			rpc,
			faucet,
			graphql,
			client,
			chainId,
			waitForTransactionsReady,
			runtime: 'bundled',
		} satisfies Sui;
	})();

	const tag = provide(SuiTag, build, {
		kind: 'service',
		displayTitle: 'sui.localnet',
		display: (s) => {
			const endpoints: Array<{ readonly label: string; readonly url: string }> = [
				{ label: 'rpc', url: s.rpc.host },
			];
			if (s.faucet !== undefined) endpoints.push({ label: 'faucet', url: s.faucet.host });
			if (s.graphql !== undefined) endpoints.push({ label: 'graphql', url: s.graphql.host });
			return {
				title: `sui.${s.network}`,
				...(endpoints.length > 1 ? { endpoints } : { primary: s.rpc.host }),
			};
		},
	});
	// Surface sibling image layers alongside our own — the indexer-db
	// postgres image always builds (only the optional caller-pinned sui
	// localnet image skips its layer when `options.image` is set). We also
	// surface a `SuiBuildImage` reference so downstream `buildMove`
	// callers dispatch `sui move build` INTO the localnet image rather
	// than against the host `sui` CLI.
	const baseLayers: ReadonlyArray<Layer.Layer<any, any, any>> = [
		...indexerDbImage.__layers,
		...(localnetImage !== undefined ? localnetImage.__layers : []),
		tag.__layer,
	];

	let buildImageLayer: Layer.Any | undefined;
	// HIGH-T5: when the user supplies their own `rpcUrl`, we're
	// wrapping an external RPC — there's no localnet container to
	// build against, and the per-stack `SuiBuildContainer` would
	// just sit idle wasting docker resources. Skip both the build
	// image layer and the container layer in that case. Move builds
	// against a wrapped external RPC use the host `sui` directly.
	const isExternalRpc = options.rpcUrl !== undefined;
	if (options.image !== undefined && !isExternalRpc) {
		const pinned = options.image;
		buildImageLayer = Layer.succeed(SuiBuildImage, { tag: pinned });
	} else if (localnetImage !== undefined && !isExternalRpc) {
		buildImageLayer = Layer.effect(
			SuiBuildImage,
			Effect.gen(function* () {
				const img = yield* localnetImage;
				return { tag: img.tag };
			}),
		);
	}
	// When we have a SuiBuildImage to drive `sui move build`, ALSO bring
	// up a long-lived per-app build container so the publishMove path
	// can `docker exec` into it instead of paying `docker run --rm`
	// container-spawn overhead on every publish. The container survives
	// across `r` hot-restart cycles (finalizer on `LongLivedScope`) so
	// the second cycle's first publish is just as fast as the first
	// cycle's second. `buildMove` falls back to per-build `docker run
	// --rm` if the service isn't provided OR the source path is outside
	// the bind-mounted app dir.
	const layers: ReadonlyArray<Layer.Layer<any, any, any>> =
		buildImageLayer !== undefined
			? [
					...baseLayers,
					buildImageLayer as Layer.Layer<any, any, any>,
					SuiBuildContainerLive as Layer.Layer<any, any, any>,
				]
			: baseLayers;
	return Object.assign(tag, { __layers: layers });
};

const buildTestnet = (options: SuiTestnetOptions): StackMember => {
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
		// Live-net handles have no docker presence.
		const rpc: Endpoint = { host: rpcUrl };
		const faucet: Endpoint = { host: faucetUrl };
		const graphql: Endpoint = { host: graphqlUrl };
		return {
			network: 'testnet',
			rpc,
			faucet,
			graphql,
			client,
			chainId,
			waitForTransactionsReady,
			runtime: 'external',
		} satisfies Sui;
	})();

	return provide(SuiTag, build, {
		kind: 'service',
		displayTitle: 'sui.testnet',
		display: (s) => {
			const endpoints: Array<{ readonly label: string; readonly url: string }> = [
				{ label: 'rpc', url: s.rpc.host },
			];
			if (s.faucet !== undefined) endpoints.push({ label: 'faucet', url: s.faucet.host });
			if (s.graphql !== undefined) endpoints.push({ label: 'graphql', url: s.graphql.host });
			return {
				title: `sui.${s.network}`,
				...(endpoints.length > 1 ? { endpoints } : { primary: s.rpc.host }),
			};
		},
	});
};

const buildMainnet = (options: SuiMainnetOptions): StackMember => {
	const build = Effect.fn('suiMainnet')(function* () {
		const rpcUrl = options.rpcUrl ?? 'https://fullnode.mainnet.sui.io:443';
		const graphqlUrl = options.graphqlUrl ?? 'https://sui-mainnet.mystenlabs.com/graphql';
		const client = new SuiJsonRpcClient({ url: rpcUrl, network: 'mainnet' });
		yield* EndpointRegistry.publish({ name: 'sui-rpc', url: rpcUrl, kind: 'rpc' });
		yield* EndpointRegistry.publish({ name: 'sui-graphql', url: graphqlUrl, kind: 'graphql' });
		const chainId = yield* fetchChainId(client);
		const waitForTransactionsReady = yield* buildWaitForTransactionsReady(undefined);
		const rpc: Endpoint = { host: rpcUrl };
		const graphql: Endpoint = { host: graphqlUrl };
		return {
			network: 'mainnet',
			rpc,
			faucet: undefined,
			graphql,
			client,
			chainId,
			waitForTransactionsReady,
			runtime: 'external',
		} satisfies Sui;
	})();

	return provide(SuiTag, build, {
		kind: 'service',
		displayTitle: 'sui.mainnet',
		display: (s) => {
			const endpoints: Array<{ readonly label: string; readonly url: string }> = [
				{ label: 'rpc', url: s.rpc.host },
			];
			if (s.graphql !== undefined) endpoints.push({ label: 'graphql', url: s.graphql.host });
			return {
				title: `sui.${s.network}`,
				...(endpoints.length > 1 ? { endpoints } : { primary: s.rpc.host }),
			};
		},
	});
};

const buildCustom = (options: SuiCustomOptions): StackMember => {
	const build = Effect.fn('suiCustom')(function* () {
		const rpcUrl = options.rpcUrl;
		const faucetUrl = options.faucetUrl;
		const graphqlUrl = options.graphqlUrl;
		const network = options.network ?? 'custom';
		// `SuiJsonRpcClient` expects a known `network` literal; pass
		// 'localnet' as the wire-level default to suppress its internal
		// chain-id mismatch warning. The surface-level `network` we return
		// in `Sui` is the caller-supplied label.
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
		const rpc: Endpoint = { host: rpcUrl };
		const faucet: Endpoint | undefined =
			faucetUrl !== undefined ? { host: faucetUrl } : undefined;
		const graphql: Endpoint | undefined =
			graphqlUrl !== undefined ? { host: graphqlUrl } : undefined;
		return {
			network,
			rpc,
			faucet,
			graphql,
			client,
			chainId,
			waitForTransactionsReady,
			runtime: 'external',
		} satisfies Sui;
	})();

	return provide(SuiTag, build, {
		kind: 'service',
		displayTitle: `sui.${options.network ?? 'custom'}`,
		display: (s) => ({ title: `sui.${s.network}`, primary: s.rpc.host }),
	});
};

// -----------------------------------------------------------------------------
// Factory
// -----------------------------------------------------------------------------

/** The canonical sui factory. Returns a Ref that's both an Effect Layer
 *  and an Effect tag (`yield* Sui` gives the `Sui`).
 *
 *  Defaults to whatever `DEVSTACK_NETWORK` resolves to (`localnet` when
 *  unset). The CLI `--network` flag and the `devstack({ network })`
 *  config option both flow through that env var. Pass `{ network: {
 *  rpc, faucet } }` for a custom RPC (corporate fullnode, pinned fork);
 *  pass `{ network: 'testnet' }` to pin in code regardless of env var. */
export const Sui = (opts: SuiOptions = {}): Ref<'@devstack/Sui', Sui> => {
	const net = opts.network ?? resolveNetwork();
	let member: StackMember;
	if (typeof net === 'object') {
		const customOpts: SuiCustomOptions = {
			rpcUrl: net.rpc,
			...(net.faucet !== undefined ? { faucetUrl: net.faucet } : {}),
		};
		member = buildCustom(customOpts);
	} else if (net === 'testnet') {
		member = buildTestnet(opts.testnet ?? {});
	} else if (net === 'mainnet') {
		member = buildMainnet(opts.mainnet ?? {});
	} else {
		member = buildLocalnet(opts.localnet ?? {});
	}
	return Object.assign(member, { __kind: 'service' as const }) as unknown as Ref<
		'@devstack/Sui',
		Sui
	>;
};
