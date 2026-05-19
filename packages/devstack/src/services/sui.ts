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
//
// Snapshot participation (per AGENTS.md § "Snapshot participation"):
//   - **What this service persists:** the localnet validator's RocksDB
//     state at `/root/.sui` (container writable layer captured by
//     `docker commit` on snapshot save), the colocated indexer-postgres
//     writable layer at `/pgdata` (off the inherited VOLUME so it rides
//     the commit), and — for `sui-fork` variants only — the per-fork
//     data dir + `meta.json` config-hash sentinel under
//     `runtime/sui-fork/<stack>/`. `publishSuiState` registers
//     `chainId` + RPC URLs into the per-stack sui state registry; on
//     restore these are re-published by the warm-resume path so the
//     manifest is identical pre/post snapshot.
//   - **What re-derives from on-chain state on apply:** nothing — chain
//     state survives via the container retag; the validator just resumes
//     from its checkpointed RocksDB. The faucet's per-account funding
//     ledger is reconstructed lazily on the first `requestFunds` call.
//   - **What is intentionally lost on snapshot restore:** account
//     balances *not* yet on chain at the snapshot point (anything mid-tx
//     during save), the in-memory mempool, faucet rate-limit windows,
//     and the indexer's WAL position relative to the validator (the
//     indexer catches up from the last checkpoint on resume).
//   - For testnet/mainnet/custom-RPC variants there is no container, so
//     this section is vacuous: nothing is persisted, everything is the
//     upstream chain.

import { Context, Effect, Layer, Ref as EffectRef, Schedule, Schema, type Stream } from 'effect';
import { SuiGrpcClient } from '@mysten/sui/grpc';
import * as Docker from '../engine/docker.js';
import { routerEntrypoint } from '../engine/docker/router.js';
import type { Endpoint } from '../engine/endpoint.js';
import { stringifyCause } from '../engine/stringify-cause.js';
import { Identity } from '../engine/identity.js';
import { publishEndpoint, publishSuiState } from '../engine/registries.js';
import { resolveAppDir } from '../engine/resolve-app-dir.js';
import { routerHostname } from '../engine/router-hostname.js';
import { SuiBuildImage } from '../engine/sui-cli.js';
import { SuiBuildContainerLive } from '../engine/sui-build-container.js';
import {
	dockerImage,
	runDockerContainer,
	type DockerContainerImage,
} from '../advanced/plugin-author/index.js';
import { provide, setPhase, type LayeredTag } from '../advanced/tag.js';
import { makeService } from '../advanced/make-service.js';
import type { StackMember } from '../engine/supervisor.js';
import { ForkUnsupportedError, SuiError } from '../engine/errors.js';
import { resolveNetwork, type SuiNetwork } from '../engine/network.js';
import { EndpointName } from '../runtime/endpoint-names.js';
import { acquireForkDataLock } from '../engine/sui-fork/file-lock.js';
import {
	type AutoTickOption,
	type ForkCheckpointEvent,
	resolveResumeAutoTickIntervalMs,
	runAutoTickClock,
	subscribeCheckpointsWithFallback,
} from '../engine/sui-fork/control.js';
import {
	ensureForkMetaConsistent,
	readForkMeta,
	resolveForkMetaPath,
} from '../engine/sui-fork/meta.js';
import { collectKnownPackageSeedObjects } from './known-package.js';
import { executeImpersonated } from './sui/impersonate.js';
import { join as pathJoin } from 'node:path';

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

// `sui-fork` binds its `sui-rpc-api` tonic server (both data-plane
// `sui.rpc.v2.*` AND admin `sui.forking.v1alpha.ForkingService`) on
// one port. The entrypoint script defaults this to `0.0.0.0:9000` so
// peers on the per-stack docker network can dial it; the host-side
// URL goes through the `sui-grpc` traefik entrypoint on port 50051.
const FORK_GRPC_PORT = 9000;

// Pinned `MystenLabs/sui` commit the vendored `sui-fork-image/`
// builder cargo-builds from. Bump in lockstep with sui-fork crate API
// changes — fold the bump + a refreshed `TEST_TESTNET_CHECKPOINT` in
// the same commit so test gates run against the bumped binary. As of
// 2026-05-18 this is `259b947bf5e7e8b9b9f3...` (Phase 1 pin); the
// vendored image is content-addressed so a bump rebuilds the layer.
// Resolved 2026-05-18 from `MystenLabs/sui` main: includes the latest
// sui-fork commits as of Phase 1 — `259b947bf5 [sui-fork] add back
// ConsensusAddressOwner support for owned objects and seeding (#26635)`.
const DEFAULT_SUI_FORK_REV = '259b947bf5b07cded7481c0c1f5e88470939c930';
const SUI_FORK_NETWORK_ALIAS = 'sui-fork';

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

// `SuiNetwork` moved to engine/network.ts (the substrate is the primary
// consumer for cache paths / resume keys / identity). Re-exported here
// so user-facing imports remain on the high-level services module.
export type { SuiNetwork } from '../engine/network.js';

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
 *
 *    Asymmetry note: the INPUT options (`Sui*Options.rpcUrl`,
 *    `faucetUrl`, `graphqlUrl`) take bare URL strings — that's all the
 *    caller can supply for an external chain. The OUTPUT `rpc` /
 *    `faucet` / `graphql` fields on this contract are structured
 *    `Endpoint`s because devstack-managed services additionally carry
 *    a docker-DNS form and the per-stack networks on which it
 *    resolves. To recover a URL string from the output, read
 *    `endpoint.host` (host-side) or use `endpointUrl(endpoint, ctx)`
 *    from `../engine/endpoint.js` for context-aware selection.
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
	readonly network:
		| 'localnet'
		| 'testnet'
		| 'mainnet'
		| 'devnet'
		| 'mainnet-fork'
		| 'testnet-fork'
		| 'devnet-fork'
		| (string & {});
	readonly rpc: Endpoint;
	readonly faucet?: Endpoint;
	readonly graphql?: Endpoint;
	readonly client: SuiGrpcClient;
	readonly chainId: string;
	readonly waitForTransactionsReady: () => Effect.Effect<void, SuiError>;
	/**
	 * Discriminator for the runtime shape of the chain backing this Sui.
	 * `'bundled'` = the vendored sui-localnet container devstack starts
	 * (full control over genesis + chain id + indexer); `'external'` =
	 * a user-supplied RPC (any chain id, no docker control, no
	 * indexer assumptions); `'forked'` = a `sui-fork` container that
	 * tracks a mainnet/testnet/devnet upstream at a specific checkpoint
	 * (per-stack mutable state, no faucet, no GraphQL, no JSON-RPC —
	 * gRPC only). `network` stays at the user's configured value
	 * (`'localnet'` even when wrapping an external RPC; `'mainnet-fork'`
	 * etc. for forks) so KnownPackage / dapp-kit network-name lookups
	 * behave consistently; downstream policy that needs to know
	 * "are we running a real localnet container?" branches on `runtime`
	 * instead. HIGH-T4.
	 */
	readonly runtime: 'bundled' | 'external' | 'forked';

	/**
	 * Fork-mode admin surface. Present when `runtime === 'forked'`,
	 * `undefined` otherwise. Thin Effect-friendly wrapper around the
	 * SDK's `client.forkingService` (`ForkingServiceClient`) that maps
	 * each `UnaryCall<Req, Resp>` to a typed `SuiError` and exposes
	 * synchronous fields (`upstream`, `forkedAtCheckpoint`) populated
	 * at acquire time so the common read path is non-async.
	 */
	readonly fork?: ForkControl;
}

/**
 * Status snapshot returned by `ForkingService.GetStatus`. Mirrors the
 * SDK's `GetStatusResponse` but converts `bigint` fields to `number`
 * (checkpoint numbers fit comfortably in `Number.MAX_SAFE_INTEGER`
 * for the foreseeable future) so consumers don't have to round-trip
 * through `BigInt`.
 */
export interface ForkStatus {
	readonly epoch: number;
	readonly checkpointSequenceNumber: number;
	readonly timestampMs: number;
	readonly forkedAtCheckpoint: number;
}

/**
 * Result of `ForkControl.advanceClock`. `timestampMs` is the post-
 * advance clock value; `txDigest` is the consensus-commit-prologue
 * transaction the advance materialized as.
 */
export interface ForkAdvanceClockResult {
	readonly timestampMs: number;
	readonly txDigest: string;
}

/**
 * Result of `ForkControl.advanceCheckpoint`. `checkpointSequenceNumber`
 * is the newly-created checkpoint's sequence number; `timestampMs` is
 * the timestamp embedded in it.
 */
export interface ForkAdvanceCheckpointResult {
	readonly checkpointSequenceNumber: number;
	readonly timestampMs: number;
}

/**
 * Admin surface exposed on `sui.fork` when `runtime === 'forked'`.
 * Adapter over the SDK's `ForkingServiceClient` (already constructed
 * on every `SuiGrpcClient` against the same transport — see
 * `~/code/ts-sdks/packages/sui/src/grpc/client.ts:72,90`).
 *
 * `upstream` and `forkedAtCheckpoint` are populated at `buildFork`
 * acquire time via a `GetStatus` round-trip so they're synchronous
 * reads after that.
 */
export interface ForkControl {
	/** Upstream network this fork tracks. */
	readonly upstream: 'mainnet' | 'testnet' | 'devnet';
	/** Upstream checkpoint the fork was anchored at on first boot. */
	readonly forkedAtCheckpoint: number;
	/** Seed addresses configured at boot. Downstream auto-funding
	 *  (Account auto-promotion in fork mode) reads from this list to
	 *  pick the impersonation sender for a `pay_sui` transfer to the
	 *  newly-generated ephemeral account. Empty when the user passed
	 *  no `Sui({fork:{seed:{addresses}}})` — auto-funding then fails
	 *  with a typed error pointing at the workaround. */
	readonly seedAddresses: ReadonlyArray<string>;
	/** Cadence (ms) the supervisor's scope-bound auto-tick fiber is
	 *  calling `advanceClock` with. `undefined` when
	 *  `Sui({fork:{autoTick}})` is unset / `false`. Surfaced here so the
	 *  dev-wallet relay (and any operator-facing observer) can report
	 *  "auto-tick active (1000ms)" without re-parsing the user's options.
	 *  Phase 5 Subtopic 3 (P5.5). */
	readonly autoTickMs?: number;
	/** Fetch the current `ForkStatus`. */
	readonly status: () => Effect.Effect<ForkStatus, SuiError>;
	/** Advance the fork's clock by `durationMs` (default 1 ms). */
	readonly advanceClock: (durationMs?: number) => Effect.Effect<ForkAdvanceClockResult, SuiError>;
	/** Seal pending txs into a new checkpoint. */
	readonly advanceCheckpoint: () => Effect.Effect<ForkAdvanceCheckpointResult, SuiError>;
	/** Subscribe to the fork's checkpoint stream. Emits one event per
	 *  new checkpoint; falls back to polling on subscription stream
	 *  error per R4. Replaces the polling-only path consumers used in
	 *  Phase 4. Phase 5 Subtopic 7 (P5.10). The returned stream is
	 *  scope-bound — drop the stream (Effect's normal scope teardown)
	 *  to close the underlying gRPC connection. */
	readonly subscribeCheckpoints: () => Stream.Stream<ForkCheckpointEvent, SuiError>;
	/**
	 * Submit a transaction with an empty signature list, executing it
	 * AS `sender` via `sui-fork`'s impersonation branch. Thin wrapper
	 * over `executeImpersonated` in `services/sui/impersonate.ts` so
	 * callers that already have the `Sui` value don't have to reach
	 * into the helper module directly. See D2 in
	 * `notes/sui-fork-integration.md` for the design rationale.
	 *
	 * Use cases:
	 *   - Fund a fresh ephemeral account from a seeded sender during
	 *     stack acquire (Phase 2 auto-promotion path).
	 *   - One-off scripts that want to execute a Move call as an
	 *     arbitrary address (e.g. a treasury cap holder).
	 */
	readonly impersonate: (
		sender: string,
		tx: import('@mysten/sui/transactions').Transaction,
		opts?: { readonly gasBudget?: bigint },
	) => Effect.Effect<import('./sui/impersonate.js').ImpersonatedTxResponse, SuiError>;
}

/** Canonical Sui service tag. Named `SuiTag` (not `Sui`) so the factory
 *  `Sui(opts?)` in this file can take the public-surface name. The
 *  Context key (`'@devstack/SuiTag'`) is unchanged, so any layer keyed
 *  against the legacy `Sui` class identity continues to resolve. */
export class SuiTag extends Context.Service<SuiTag, Sui>()('@devstack/SuiTag') {}

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
							`5xx). The HTTP socket is bound but the validator isn't accepting funding ` +
							`txs. Typical causes: (1) chain still mid-genesis on a cold start ` +
							`(should recover in <30s); (2) inconsistent on-disk state from a prior ` +
							`SIGKILL'd shutdown — look for "UNCLEAN PRIOR SHUTDOWN" earlier in the ` +
							`log panel. Recovery for (2): pnpm exec devstack wipe --yes && pnpm exec devstack up`,
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
		Effect.withSpan('SuiWaitForTransactionsReady'),
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
const fetchChainId = (client: SuiGrpcClient): Effect.Effect<string, SuiError> =>
	Effect.gen(function* () {
		const chainId = yield* Effect.tryPromise({
			try: () => client.core.getChainIdentifier().then((r) => r.chainIdentifier),
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
		Effect.withSpan('SuiIndexerReady'),
	);
};

// -----------------------------------------------------------------------------
// Factory option types
// -----------------------------------------------------------------------------

/** Localnet-specific knobs. Pass via `Sui({ localnet: {...} })`. */
export interface SuiLocalnetOptions {
	/** Pre-built image reference. Accepts the unified Phase 3.8
	 *  `DockerContainerImage` shape: `{pull: 'org/sui:tag'}` for a
	 *  registry image (e.g. an air-gapped GHCR mirror) or
	 *  `{build: {context, dockerfile, buildArgs}}` for a local
	 *  Dockerfile build that overrides the vendored `sui-image/`
	 *  context. When set, `version` is ignored and the vendored
	 *  `sui-image/` build is skipped.
	 *
	 *  Bare-string image references (`image: 'mysten/sui:latest'`) are
	 *  intentionally rejected at the type level — every callsite must
	 *  spell out pull vs build so the option doesn't mean both at
	 *  different sites. */
	readonly image?: DockerContainerImage;
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

/**
 * Fork-mode knobs. Used when `Sui({ network: 'mainnet-fork' | 'testnet-fork' | 'devnet-fork' })`.
 *
 * The fork is anchored at `seed` (addresses + objects) on first boot;
 * subsequent boots resume from the on-disk `seed_manifest.json`. The
 * upstream is derived from the `network` literal (`'mainnet-fork'` →
 * `'mainnet'` etc.) and passed to `sui-fork start --network`.
 */
export interface SuiForkOptions {
	/** Pre-built image reference. Accepts the unified Phase 3.8
	 *  `DockerContainerImage` shape: `{pull: 'org/sui-fork:tag'}` for a
	 *  registry image (e.g. a GHCR mirror) or
	 *  `{build: {context, dockerfile, buildArgs}}` for a local Dockerfile
	 *  build that overrides the vendored `sui-fork-image/` context.
	 *  When set, `version` / the vendored `sui-fork-image/` build are
	 *  skipped. Bare-string image references are rejected at the type
	 *  level — see `SuiLocalnetOptions.image` for the rationale. */
	readonly image?: DockerContainerImage;
	/** Upstream `MystenLabs/sui` commit the vendored Dockerfile builds
	 *  from when `image` is unset. Threaded through as `SUI_REV` build
	 *  arg. The default lives in `services/sui.ts`'s `DEFAULT_SUI_FORK_REV`
	 *  constant — refresh quarterly. */
	readonly version?: string;
	/** Upstream checkpoint to fork at. Omitted means latest. */
	readonly checkpoint?: number;
	/** Seed inputs — addresses whose owned objects pre-populate the
	 *  fork's local index (so `listOwnedObjects` works for them), and
	 *  arbitrary object IDs to pre-fetch (so reads against them hit the
	 *  local index instead of the upstream GraphQL). `addresses` is the
	 *  primary knob for Phase 2's impersonation funding pattern. */
	readonly seed?: {
		readonly addresses?: ReadonlyArray<string>;
		readonly objects?: ReadonlyArray<string>;
	};
	/** Default gas budget the supervisor injects on outgoing txs that
	 *  don't set one explicitly. `sui-fork`'s `simulate_transaction`
	 *  returns `"unsupported"`, so the SDK's auto-gas-budget path
	 *  errors — we sidestep that by stamping a sane budget. Default
	 *  `100_000_000n` (0.1 SUI). R3 mitigation. */
	readonly defaultGasBudget?: bigint;
	/** Total wall-clock budget for the fork to become ready, measured
	 *  from container start. Default 180_000 (180s) — cold-start needs
	 *  serial upstream GraphQL fetches to warm system state (R10), and
	 *  120s is sometimes not enough on a slow connection. */
	readonly readyTimeoutMs?: number;
	/** Auto-tick the on-chain clock at a wall-clock cadence. Phase 5
	 *  Subtopic 3 (P5.5) — move-side logic that gates on
	 *  `clock::timestamp_ms()` (auctions, vesting, time-window
	 *  vaults) is painful to develop against a fork because the clock
	 *  only advances on explicit `advanceClock` RPC calls. Setting
	 *  this option spawns a scope-bound supervisor fiber that fires
	 *  `ForkControl.advanceClock(intervalMs)` on a
	 *  `Schedule.spaced(intervalMs)` cadence.
	 *
	 *  Shape:
	 *    `autoTick: true`               → 1000 ms cadence (default)
	 *    `autoTick: { intervalMs: N }`  → custom cadence (positive ms)
	 *    `autoTick: false` / undefined  → no auto-tick (the default)
	 *
	 *  Contract: the cadence is WALL-CLOCK, not real chain time. Two
	 *  ticks may overlap a manual `ForkControl.advanceClock` call —
	 *  the fork serializes them internally, but the resulting clock
	 *  reading is "best effort current wall-clock", not a precise
	 *  monotonic counter.
	 *
	 *  Failure policy: a single advance-clock RPC failure (e.g. mid-
	 *  restart, transient gRPC blip) is logged at WARN and the next
	 *  tick continues. We deliberately do NOT propagate the failure
	 *  into the surrounding scope: an auto-tick blip should not tear
	 *  the whole stack down. See R9 in `notes/sui-fork-integration.md`. */
	readonly autoTick?: AutoTickOption;
}

export interface SuiOptions {
	/** Which sui network to provide. Defaults to `'localnet'`, which
	 *  spins up a local sui-test-validator container with embedded
	 *  faucet + GraphQL. `'testnet'`/`'mainnet'` produce RPC-only
	 *  handles pointing at the public fullnodes. Pass an object form
	 *  (`{ rpc, faucet? }`) for custom RPC endpoints (corporate fullnodes,
	 *  pinned forks, air-gapped mirrors). Fork variants (`'mainnet-fork'`,
	 *  `'testnet-fork'`, `'devnet-fork'`) start a `sui-fork` container
	 *  anchored at the wrapped upstream — pass `fork` for seed inputs +
	 *  checkpoint pinning.
	 *
	 *  Grandfathered exception to AGENTS.md's `kind:` discriminator
	 *  convention (synthesis F-03; review-followups §10.5 settled
	 *  2026-05-19): `network:` doubles as the network-selector input
	 *  *and* the resolved-network output on `Sui.network`. Renaming to
	 *  `kind:` would break a published API for marginal type-safety
	 *  gain, so the legacy shape stays. New services adopt `kind:`. */
	readonly network?:
		| 'localnet'
		| 'testnet'
		| 'mainnet'
		| 'mainnet-fork'
		| 'testnet-fork'
		| 'devnet-fork'
		| { readonly rpc: string; readonly faucet?: string };

	/** Pass-through extras for the localnet variant. Ignored on testnet /
	 *  mainnet / custom. */
	readonly localnet?: SuiLocalnetOptions;
	/** Pass-through extras for testnet. */
	readonly testnet?: SuiTestnetOptions;
	/** Pass-through extras for mainnet. */
	readonly mainnet?: SuiMainnetOptions;
	/** Pass-through extras for the fork variants. Ignored unless
	 *  `network` is one of the `*-fork` literals. */
	readonly fork?: SuiForkOptions;
}

// -----------------------------------------------------------------------------
// Per-network builders. Module-private — call sites flow through Sui().
// -----------------------------------------------------------------------------

const buildLocalnet = (options: SuiLocalnetOptions): StackMember => {
	const version = options.version ?? DEFAULT_SUI_VERSION;

	// Sibling tag for the localnet image. Three paths:
	//
	//   - `options.image === undefined`        → vendored `sui-image/` build.
	//   - `options.image = {build: {…}}`       → caller-supplied build context.
	//   - `options.image = {pull: 'org/sui:t'}` → caller-pinned registry tag.
	//
	// `dockerImage({build})` is content-addressed — the tag folds in a
	// hash of the Dockerfile + entrypoint.sh + `SUI_VERSION`, so an edit
	// to any of those flips the tag and forces a rebuild while identical
	// inputs hit the docker cache. The `pull` branch hands the upstream
	// tag through unchanged so a later snapshot/restore retag finds the
	// expected name.
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
			: 'build' in options.image
				? dockerImage({ name: 'sui.image', build: options.image.build })
				: dockerImage({ name: 'sui.image', pull: options.image.pull });

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
			const client = new SuiGrpcClient({ baseUrl: rpcUrl, network: 'localnet' });
			yield* publishEndpoint({ name: EndpointName.SUI_RPC, url: rpcUrl, kind: 'rpc' });
			if (faucetUrl !== undefined) {
				yield* publishEndpoint({
					name: EndpointName.SUI_FAUCET,
					url: faucetUrl,
					kind: 'faucet',
				});
			}
			if (graphqlUrl !== undefined) {
				yield* publishEndpoint({
					name: EndpointName.SUI_GRAPHQL,
					url: graphqlUrl,
					kind: 'graphql',
				});
			}
			const chainId = yield* fetchChainId(client);
			yield* publishSuiState({ name: 'sui.localnet', chainId });
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
		//
		// `localnetImage` resolves the image regardless of which branch
		// of `DockerContainerImage` the caller supplied: pull-mode
		// returns the verbatim tag, build-mode returns a content-
		// addressed `devstack-sui.image:<hash>` tag. Either way the
		// `.tag` string is what `Docker.run` consumes.
		yield* setPhase('resolving image');
		const image = (yield* localnetImage).tag;
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
					message: 'sui-localnet: router entrypoints sui-rpc/sui-faucet/sui-graphql not registered',
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
		//
		// `runDockerContainer({tag})` consumes the image tag the sibling
		// `indexerDbImage` already materialized at factory time (see
		// `__layers` wiring below). No back-compat with raw `Docker.run`
		// here — the plugin primitive owns name composition, finalizer
		// scope, and reuse-if-image-matches resume.
		const indexerDbImageTag = yield* indexerDbImage;
		yield* setPhase('starting indexer-db');
		const indexerDb = yield* runDockerContainer('sui.indexer-db', {
			image: { tag: indexerDbImageTag.tag },
			env: {
				POSTGRES_USER: SUI_INDEXER_DB_USER,
				POSTGRES_PASSWORD: SUI_INDEXER_DB_PASSWORD,
				POSTGRES_DB: SUI_INDEXER_DB_NAME,
			},
			network: networkName,
			networkAlias: SUI_INDEXER_DB_NETWORK_ALIAS,
			// Postgres needs a clean shutdown to avoid `recovery mode` on
			// next start. 20s lets it finalize any open WAL segment.
			stopGraceSeconds: 20,
		}).effect.pipe(
			Effect.catchTag('DockerError', (cause) =>
				Effect.fail(
					new SuiError({
						phase: 'postgres-up',
						message: 'failed to start sui indexer-db container',
						cause,
					}),
				),
			),
			Effect.catchTag('ReadyProbeError', (cause) =>
				Effect.fail(
					new SuiError({
						phase: 'postgres-up',
						message: 'sui indexer-db container failed ready probe',
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
		// `routing` carries one entry per service port; each
		// `routing[].name` matches the segment passed to `routerId` /
		// `routerHostname` so the file-provider YAML keys match what
		// the sibling services downstream expect. `routerHostname` is
		// derived from `routing[].name` (or the outer container name
		// when omitted) inside `runDockerContainer`, so passing
		// `'sui'` / `'faucet'` / `'graphql'` keeps the same stack-
		// scoped hostnames the previous `Docker.run({traefik: ...})`
		// callsite minted.
		const localnetRunResult = yield* runDockerContainer('sui.localnet', {
			image: { tag: image },
			args: [
				'start',
				'--with-faucet=0.0.0.0:9123',
				`--with-indexer=${SUI_INDEXER_DATABASE_URL}`,
				'--with-graphql=0.0.0.0:9125',
			],
			...(ports !== undefined ? { ports } : {}),
			network: networkName,
			networkAlias: SUI_LOCALNET_NETWORK_ALIAS,
			// Sui-localnet exit 137 ("UNCLEAN PRIOR SHUTDOWN" alert on the
			// next `up`) is currently unavoidable when running with
			// `--with-faucet`. Upstream bug, traced through:
			//   - sui/src/sui_commands.rs:1287 — `tokio::signal::ctrl_c()`
			//     is in the post-setup health-check loop.
			//   - sui-faucet/src/server.rs:129 — `start_faucet` ends with
			//     `axum::serve(...).await?` which BLOCKS forever.
			//   - With `--with-faucet`, `start_faucet().await?` is the last
			//     awaited call before the loop, so `ctrl_c()` is never
			//     polled and the SIGINT handler is never registered.
			//   - Verified empirically: `/proc/1/status` SigCgt =
			//     0x100000440 (no SIGINT/SIGTERM bits) with `--with-faucet`;
			//     `kill -INT 1` inside the container is a no-op.
			//     `start` without `--with-faucet` registers SIGINT
			//     (SigCgt = 0x100000442) and exits 0 in <1s.
			//
			// So no signal works as PID 1 — only SIGKILL terminates the
			// validator. `stopGraceSeconds: 30` is the wait before docker
			// falls back to SIGKILL; the validator runs to that ceiling
			// and exits 137 every shutdown. RocksDB's WAL has kept this
			// recoverable in practice (e2e suites pass across SIGTERM →
			// resume → e2e), but the alert keeps firing.
			//
			// (Infrastructure for `stopSignal` lives in
			// `engine/docker/core.ts` / `plugin-author/docker-container.ts`
			// for primitives whose binary actually traps a specific signal
			// — useful for future plugins and for the sui-fork path. Just
			// not applicable here.)
			stopGraceSeconds: 30,
			routing: [
				{
					name: 'sui',
					entrypoint: 'sui-rpc',
					servicePort: LOCAL_RPC_PORT,
				},
				{
					name: 'faucet',
					entrypoint: 'sui-faucet',
					servicePort: LOCAL_FAUCET_PORT,
				},
				{
					name: 'graphql',
					entrypoint: 'sui-graphql',
					servicePort: LOCAL_GRAPHQL_PORT,
				},
			],
		}).effect.pipe(
			Effect.catchTag('DockerError', (cause) =>
				Effect.fail(
					new SuiError({
						phase: 'sui-up',
						message: 'failed to start sui localnet container',
						cause,
					}),
				),
			),
			Effect.catchTag('ReadyProbeError', (cause) =>
				Effect.fail(
					new SuiError({
						phase: 'sui-up',
						message: 'sui localnet container failed ready probe',
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
		const client = new SuiGrpcClient({ baseUrl: rpcUrl, network: 'localnet' });

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

		type ProbeKey = 'rpc' | 'faucet' | 'graphql';
		const seen = yield* EffectRef.make(new Set<ProbeKey>());
		const markSeen = (k: ProbeKey) => EffectRef.update(seen, (s) => new Set(s).add(k));
		const rpcProbe = Effect.tryPromise({
			try: () => client.core.getChainIdentifier(),
			catch: (cause) => new Error(`rpc: ${stringifyCause(cause)}`),
		}).pipe(
			Effect.tap(() => markSeen('rpc')),
			Effect.withSpan('SuiProbeRpc'),
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
			Effect.tap(() => markSeen('faucet')),
			Effect.withSpan('SuiProbeFaucet'),
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
			Effect.tap(() => markSeen('graphql')),
			Effect.withSpan('SuiProbeGraphql'),
		);
		yield* Effect.all([rpcProbe, faucetProbe, graphqlProbe], {
			concurrency: 'unbounded',
		}).pipe(
			Effect.retry(Schedule.spaced('1 seconds')),
			Effect.timeoutOrElse({
				duration: `${readyTimeoutMs} millis`,
				orElse: () =>
					Effect.gen(function* () {
						const observed = yield* EffectRef.get(seen);
						const tail = yield* Docker.dockerLogsTail(localnetRunResult.name);
						const stillFailing = (['rpc', 'faucet', 'graphql'] as const).filter(
							(k) => !observed.has(k),
						);
						const lagSummary =
							stillFailing.length === 0
								? 'all three probes succeeded at least once individually but never together'
								: `never-succeeded: ${stillFailing.join(', ')}`;
						return yield* Effect.fail(
							new SuiError({
								phase: 'ready-probe',
								message: `sui localnet did not become fully ready within ${readyTimeoutMs}ms (rpc=${observed.has('rpc')} faucet=${observed.has('faucet')} graphql=${observed.has('graphql')}); ${lagSummary}; sui-rpc=${rpcUrl} faucet=${faucetUrl} graphql=${graphqlUrl}`,
								stderr: tail.length > 0 ? tail : undefined,
							}),
						);
					}),
			}),
		);

		yield* publishEndpoint({ name: EndpointName.SUI_RPC, url: rpcUrl, kind: 'rpc' });
		yield* publishEndpoint({
			name: EndpointName.SUI_FAUCET,
			url: faucetUrl,
			kind: 'faucet',
		});
		yield* publishEndpoint({
			name: EndpointName.SUI_GRAPHQL,
			url: graphqlUrl,
			kind: 'graphql',
		});
		yield* publishEndpoint({
			name: EndpointName.SUI_INDEXER_DB,
			url: SUI_INDEXER_DATABASE_URL,
			kind: 'internal',
		});

		const chainId = yield* fetchChainId(client);
		yield* publishSuiState({ name: 'sui.localnet', chainId });
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
		plugin: 'sui',
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
		// Phase B (notes/parallel-graph-resolution.md §3.1): the sui
		// builders are leaves from the stack graph's perspective. The body
		// yields `Identity` (a Context.Service satisfied by InfraLive at
		// run time, not a stack member) and the two sibling LayeredTags
		// `localnetImage` / `indexerDbImage` — but those siblings are
		// folded into the same composite via `__layers` and don't enter
		// `__upstreamKeys` (mirrors `services/walrus/local-cluster.ts`,
		// which treats `upstreamImage` / `moveSource` the same way).
		upstreamKeys: [],
	});
	// Surface sibling image layers alongside our own. Both the indexer-db
	// postgres image and the sui localnet image flow through `dockerImage`
	// regardless of which `DockerContainerImage` branch the caller picked,
	// so both sub-tags' layers contribute. We also surface a
	// `SuiBuildImage` reference so downstream `buildMove` callers
	// dispatch `sui move build` INTO the localnet image rather than
	// against the host `sui` CLI.
	const baseLayers: ReadonlyArray<Layer.Layer<any, any, any>> = [
		...indexerDbImage.__layers,
		...localnetImage.__layers,
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
	if (!isExternalRpc) {
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
	// container-spawn overhead on every publish. The container's
	// finalizer attaches to the SuiBuildContainer layer's own primitive
	// scope; targeted watch-fires only invalidate primitives in the
	// affected closure, and `r` cascades full teardown through every
	// primitive. `buildMove` falls back to per-build `docker run --rm`
	// if the service isn't provided OR the source path is outside the
	// bind-mounted app dir.
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
		const client = new SuiGrpcClient({ baseUrl: rpcUrl, network: 'testnet' });
		yield* publishEndpoint({ name: EndpointName.SUI_RPC, url: rpcUrl, kind: 'rpc' });
		yield* publishEndpoint({
			name: EndpointName.SUI_FAUCET,
			url: faucetUrl,
			kind: 'faucet',
		});
		yield* publishEndpoint({
			name: EndpointName.SUI_GRAPHQL,
			url: graphqlUrl,
			kind: 'graphql',
		});
		const chainId = yield* fetchChainId(client);
		yield* publishSuiState({ name: 'sui.testnet', chainId });
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
		plugin: 'sui',
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
		// Phase B: live-net handle, pure RPC wrapper — no in-stack
		// upstreams (no LayeredTag yields, no sibling image layers).
		upstreamKeys: [],
	});
};

const buildMainnet = (options: SuiMainnetOptions): StackMember => {
	const build = Effect.fn('suiMainnet')(function* () {
		const rpcUrl = options.rpcUrl ?? 'https://fullnode.mainnet.sui.io:443';
		const graphqlUrl = options.graphqlUrl ?? 'https://sui-mainnet.mystenlabs.com/graphql';
		const client = new SuiGrpcClient({ baseUrl: rpcUrl, network: 'mainnet' });
		yield* publishEndpoint({ name: EndpointName.SUI_RPC, url: rpcUrl, kind: 'rpc' });
		yield* publishEndpoint({
			name: EndpointName.SUI_GRAPHQL,
			url: graphqlUrl,
			kind: 'graphql',
		});
		const chainId = yield* fetchChainId(client);
		yield* publishSuiState({ name: 'sui.mainnet', chainId });
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
		plugin: 'sui',
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
		// Phase B: mainnet handle, pure RPC wrapper — no in-stack
		// upstreams.
		upstreamKeys: [],
	});
};

const buildCustom = (options: SuiCustomOptions): StackMember => {
	const build = Effect.fn('suiCustom')(function* () {
		const rpcUrl = options.rpcUrl;
		const faucetUrl = options.faucetUrl;
		const graphqlUrl = options.graphqlUrl;
		const network = options.network ?? 'custom';
		// `SuiGrpcClient` accepts arbitrary `network` strings (the
		// `Network` type is `... | (string & {})`), so we pass the
		// caller-supplied label directly. The surface-level `network`
		// we return in `Sui` is the same string.
		const client = new SuiGrpcClient({ baseUrl: rpcUrl, network });
		yield* publishEndpoint({ name: EndpointName.SUI_RPC, url: rpcUrl, kind: 'rpc' });
		if (faucetUrl !== undefined) {
			yield* publishEndpoint({
				name: EndpointName.SUI_FAUCET,
				url: faucetUrl,
				kind: 'faucet',
			});
		}
		if (graphqlUrl !== undefined) {
			yield* publishEndpoint({
				name: EndpointName.SUI_GRAPHQL,
				url: graphqlUrl,
				kind: 'graphql',
			});
		}
		const chainId = yield* fetchChainId(client);
		yield* publishSuiState({ name: `sui.${network}`, chainId });
		const waitForTransactionsReady = yield* buildWaitForTransactionsReady(faucetUrl);
		const rpc: Endpoint = { host: rpcUrl };
		const faucet: Endpoint | undefined = faucetUrl !== undefined ? { host: faucetUrl } : undefined;
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
		plugin: 'sui',
		displayTitle: `sui.${options.network ?? 'custom'}`,
		display: (s) => ({ title: `sui.${s.network}`, primary: s.rpc.host }),
		// Phase B: custom-RPC handle. The caller supplies bare URLs and we
		// wrap them — no LayeredTag yields, no sibling image layers.
		upstreamKeys: [],
	});
};

// -----------------------------------------------------------------------------
// Fork builder
// -----------------------------------------------------------------------------

/**
 * Surfaces on `SuiGrpcClient.core` that `sui-fork` does NOT implement.
 * The fork's `sui_fork::store` panics (`todo!()`) for these methods —
 * see `crates/sui-fork/src/store.rs:1198,1206,1214`. We wrap the
 * client with a Proxy at acquire time to throw `ForkUnsupportedError`
 * BEFORE the wire call so the fork process stays up.
 *
 * Each entry pairs the method name with a one-line `hint` pointing
 * at the workaround so the error message is actionable.
 */
const FORK_UNSUPPORTED_CORE_SURFACES: ReadonlyMap<string, string> = new Map([
	[
		'getBalance',
		'Use `client.core.listCoins({owner, coinType})` and sum the response.objects[*].balance.',
	],
	[
		'listBalances',
		'Use `client.core.listCoins(...)` per coin type and reduce the response into a per-type total.',
	],
	[
		'getCoinInfo',
		'sui-fork does not expose `getCoinInfo`. Read metadata via `client.core.getObject` on the CoinMetadata id directly.',
	],
]);

const forkGuard = (client: SuiGrpcClient): SuiGrpcClient => {
	const guardedCore = new Proxy(client.core as object, {
		get(target, prop, receiver) {
			if (typeof prop === 'string' && FORK_UNSUPPORTED_CORE_SURFACES.has(prop)) {
				const hint = FORK_UNSUPPORTED_CORE_SURFACES.get(prop)!;
				return () => {
					throw new ForkUnsupportedError({
						surface: prop,
						message:
							`sui-fork does not implement \`client.core.${prop}\` ` +
							`(the fork process would panic — see crates/sui-fork/src/store.rs todo!()).`,
						hint,
					});
				};
			}
			return Reflect.get(target, prop, receiver);
		},
	});
	// `Object.create` + `Object.defineProperties` so the proxied client
	// still type-checks as a `SuiGrpcClient` (everything except `core`
	// flows through unchanged — `forkingService`, `transactionExecutionService`,
	// `waitForTransaction`, `signAndExecuteTransaction`, etc.). We don't
	// reassign onto `client` itself because the SDK declares several
	// fields as `readonly`.
	return new Proxy(client, {
		get(target, prop, receiver) {
			if (prop === 'core') return guardedCore;
			return Reflect.get(target, prop, receiver);
		},
	}) as SuiGrpcClient;
};

/** Resolve the upstream network name from a fork variant literal. */
const forkUpstream = (network: SuiNetwork): 'mainnet' | 'testnet' | 'devnet' => {
	if (network === 'mainnet-fork') return 'mainnet';
	if (network === 'testnet-fork') return 'testnet';
	if (network === 'devnet-fork') return 'devnet';
	throw new Error(`forkUpstream: ${network} is not a fork variant`);
};

const buildForkControl = (
	client: SuiGrpcClient,
	upstream: 'mainnet' | 'testnet' | 'devnet',
	forkedAtCheckpoint: number,
	seedAddresses: ReadonlyArray<string>,
	autoTickMs: number | undefined,
): ForkControl => {
	const status = (): Effect.Effect<ForkStatus, SuiError> =>
		Effect.tryPromise({
			try: () => client.forkingService.getStatus({}).response,
			catch: (cause) =>
				new SuiError({
					phase: 'fork-status',
					message: `sui.fork.status failed: ${stringifyCause(cause)}`,
					cause,
				}),
		}).pipe(
			Effect.map((resp) => ({
				epoch: Number(resp.epoch),
				checkpointSequenceNumber: Number(resp.checkpointSequenceNumber),
				timestampMs: Number(resp.timestampMs),
				forkedAtCheckpoint: Number(resp.forkedAtCheckpoint),
			})),
			Effect.withSpan('SuiForkStatus'),
		);

	const advanceClock = (durationMs?: number): Effect.Effect<ForkAdvanceClockResult, SuiError> =>
		Effect.tryPromise({
			try: () =>
				client.forkingService.advanceClock(
					durationMs !== undefined ? { durationMs: BigInt(durationMs) } : {},
				).response,
			catch: (cause) =>
				new SuiError({
					phase: 'fork-advance-clock',
					message: `sui.fork.advanceClock failed: ${stringifyCause(cause)}`,
					cause,
				}),
		}).pipe(
			Effect.map((resp) => ({
				timestampMs: Number(resp.timestampMs),
				txDigest: resp.txDigest,
			})),
			Effect.withSpan('SuiForkAdvanceClock', {
				attributes: { 'fork.durationMs': durationMs ?? 1 },
			}),
		);

	const advanceCheckpoint = (): Effect.Effect<ForkAdvanceCheckpointResult, SuiError> =>
		Effect.tryPromise({
			try: () => client.forkingService.advanceCheckpoint({}).response,
			catch: (cause) =>
				new SuiError({
					phase: 'fork-advance-checkpoint',
					message: `sui.fork.advanceCheckpoint failed: ${stringifyCause(cause)}`,
					cause,
				}),
		}).pipe(
			Effect.map((resp) => ({
				checkpointSequenceNumber: Number(resp.checkpointSequenceNumber),
				timestampMs: Number(resp.timestampMs),
			})),
			Effect.withSpan('SuiForkAdvanceCheckpoint'),
		);

	const impersonate: ForkControl['impersonate'] = (sender, tx, opts) =>
		executeImpersonated(client, sender, tx, opts);

	// Subscription wire model — Phase 5 Subtopic 7 (P5.10). The factory
	// returns a fresh Stream each call so two consumers (CLI `--follow`
	// + dev-wallet panel) each get their own gRPC subscription and the
	// underlying connection ties to their own scope. The fallback path
	// is baked in: subscription error → polling at 2s.
	const subscribeCheckpoints: ForkControl['subscribeCheckpoints'] = () =>
		subscribeCheckpointsWithFallback(client);

	return {
		upstream,
		forkedAtCheckpoint,
		seedAddresses,
		...(autoTickMs !== undefined ? { autoTickMs } : {}),
		status,
		advanceClock,
		advanceCheckpoint,
		impersonate,
		subscribeCheckpoints,
	};
};

/** Per-stack docker network for the fork container. Mirrors
 *  `suiNetworkName`'s composition so two stacks (and stack-vs-localnet
 *  collisions) stay disambiguated. */
const suiForkNetworkName = (identity: {
	readonly app: string;
	readonly stack: string;
	readonly network: SuiNetwork;
}): string => {
	const base =
		identity.stack === 'main'
			? `${identity.app}-sui-fork-network`
			: `${identity.app}-${identity.stack}-sui-fork-network`;
	return `${base}-${identity.network}`;
};

const buildFork = (
	options: SuiForkOptions,
	network: 'mainnet-fork' | 'testnet-fork' | 'devnet-fork',
): StackMember => {
	const upstream = forkUpstream(network);
	const rev = options.version ?? DEFAULT_SUI_FORK_REV;

	// `forkImage` resolves the image regardless of which `DockerContainerImage`
	// branch the caller supplied: undefined → vendored `sui-fork-image/`
	// build; `{build: …}` → caller-supplied context; `{pull: …}` →
	// registry tag handed through unchanged.
	const dockerContext = new URL('../../sui-fork-image/', import.meta.url).pathname;
	const forkImage =
		options.image === undefined
			? dockerImage({
					name: 'sui.fork.image',
					build: {
						context: dockerContext,
						dockerfile: 'Dockerfile',
						buildArgs: { SUI_REV: rev },
					},
				})
			: 'build' in options.image
				? dockerImage({ name: 'sui.fork.image', build: options.image.build })
				: dockerImage({ name: 'sui.fork.image', pull: options.image.pull });

	const build = Effect.fn('suiFork')(function* () {
		const identity = yield* Identity;
		const hostnameRpc = routerHostname(identity, 'sui');
		const grpcEntrypointInfo = routerEntrypoint('sui-grpc');
		if (grpcEntrypointInfo === undefined) {
			return yield* Effect.fail(
				new SuiError({
					phase: 'sui-up',
					message: 'sui-fork: router entrypoint sui-grpc not registered (engine/docker/router.ts)',
				}),
			);
		}
		const grpcEntrypointPort = grpcEntrypointInfo.port;

		// File lock — refuse to start if another live supervisor holds
		// the fork's data dir (R5 mitigation). Lock lives next to the
		// in-container data dir so `wipe` cleans it alongside.
		const appDir = resolveAppDir();
		const stackForkRoot = pathJoin(appDir, '.devstack', 'stacks', identity.stack, 'sui-fork');
		const lockPath = pathJoin(stackForkRoot, 'data.lock');
		yield* setPhase('acquiring data-dir lock');
		yield* acquireForkDataLock(lockPath);

		// Meta consistency gate (R6 mitigation; Phase 4 P4.16). Compares
		// the current `SuiForkOptions` against the on-disk meta.json so a
		// config drift surfaces with an actionable
		// `SeedManifestMismatchError` BEFORE we hand the data dir to
		// sui-fork — whose own write-once seed manifest check (R6) fails
		// later with a non-actionable Rust panic message.
		const seedAddrsRaw = options.seed?.addresses ?? [];
		// Phase 3 P3.7: union the user-supplied seed objects with any
		// `KnownPackage(..., {seedObjects})` accumulated at composition
		// time. Order doesn't matter — `acquire` runs strictly AFTER all
		// factories have evaluated — and the dedupe via `Set` absorbs
		// duplicates (a package id referenced by both `SuiForkOptions.seed`
		// and a `KnownPackage` lands once). The merged set folds into
		// `configHash` below so swapping a KnownPackage's `seedObjects`
		// list trips the same `SeedManifestMismatchError` recipe as
		// mutating `options.seed.objects` directly (R6 mitigation).
		const knownPackageSeedObjs = collectKnownPackageSeedObjects();
		const seedObjsRaw =
			knownPackageSeedObjs.length === 0
				? (options.seed?.objects ?? [])
				: [...new Set([...(options.seed?.objects ?? []), ...knownPackageSeedObjs])];
		const metaPath = resolveForkMetaPath(identity.stack, appDir);
		yield* setPhase('checking fork meta');
		// Peek at the on-disk meta first so we can fold any persisted
		// `runtime.autoTickMs` (P5.5.4) into the fresh-option precedence
		// before we re-write the meta file below. `ensureForkMetaConsistent`
		// also reads the meta internally; the cost of this second read
		// is a single fs.stat + JSON.parse, well below the docker / RPC
		// budget the supervisor's about to spend.
		const savedMeta = yield* readForkMeta(metaPath);
		const autoTickMs = resolveResumeAutoTickIntervalMs({
			...(options.autoTick !== undefined ? { option: options.autoTick } : {}),
			...(savedMeta?.runtime?.autoTickMs !== undefined
				? { savedAutoTickMs: savedMeta.runtime.autoTickMs }
				: {}),
		});
		yield* ensureForkMetaConsistent({
			metaPath,
			current: {
				upstream,
				...(options.checkpoint !== undefined ? { checkpoint: options.checkpoint } : {}),
				seedAddresses: seedAddrsRaw,
				seedObjects: seedObjsRaw,
			},
			// Persist the resolved cadence — runtime carry, excluded from
			// `configHash` (see `engine/sui-fork/meta.ts` runtime carry note).
			runtime: { ...(autoTickMs !== undefined ? { autoTickMs } : {}) },
		}).pipe(Effect.catchTag('SeedManifestMismatchError', (cause) => Effect.fail(cause)));

		// Resolve image — `forkImage` is always defined now and produces
		// the right tag for whichever branch of `DockerContainerImage`
		// the caller supplied (or the vendored default when omitted).
		yield* setPhase('resolving image');
		const image = (yield* forkImage).tag;

		// Per-stack docker network so the fork's `sui-fork` DNS alias
		// resolves from peer containers (deepbook indexer etc. in
		// Phase 3+). Also lets two stacks of the same app run forks
		// concurrently without colliding on the in-container port.
		const networkName = suiForkNetworkName(identity);
		yield* Docker.networkCreate(networkName).pipe(
			Effect.catchTag('DockerError', (cause) =>
				Effect.fail(
					new SuiError({
						phase: 'network-create',
						message: `failed to create sui-fork docker network '${networkName}'`,
						cause,
					}),
				),
			),
		);

		// Env vars consumed by the entrypoint script. The entrypoint
		// translates these to `sui-fork start --network ... --checkpoint ...
		// --address ... --object ...` flags. We don't pass `--data-dir`
		// — the container's writable layer carries chain state, snapshotted
		// via `docker commit` like the localnet path.
		const env: Record<string, string> = {
			SUI_FORK_NETWORK: upstream,
			SUI_FORK_RPC_ADDR: `0.0.0.0:${FORK_GRPC_PORT}`,
		};
		if (options.checkpoint !== undefined) {
			env.SUI_FORK_CHECKPOINT = String(options.checkpoint);
		}
		// `seedAddrsRaw` / `seedObjsRaw` were captured above for the
		// meta consistency gate — reuse them here so the two reads see
		// the same value (any future caller-side mutation between the
		// meta check and the env construction would silently produce
		// a meta.json whose configHash didn't match the env actually
		// passed to the container).
		const seedAddrs = seedAddrsRaw;
		if (seedAddrs.length > 0) {
			env.SUI_FORK_SEED_ADDRS = seedAddrs.join(',');
		}
		const seedObjs = seedObjsRaw;
		if (seedObjs.length > 0) {
			env.SUI_FORK_SEED_OBJS = seedObjs.join(',');
		}

		yield* setPhase('starting sui-fork');
		// One traefik entry for the unified gRPC port — `sui-fork`
		// serves BOTH `sui.rpc.v2.*` (data plane) AND
		// `sui.forking.v1alpha.ForkingService` (admin) on the same
		// listener. `protocol: 'h2c'` so Traefik dials HTTP/2
		// cleartext instead of HTTP/1.1. `routing[].name` defaults to
		// `'sui'` so the resulting `routerId(identity, 'sui')` /
		// `routerHostname(identity, 'sui')` match what the localnet
		// branch mints (this is intentional — the fork wraps an
		// upstream so the host-side URL stays on `sui.<app>.localhost`).
		const forkRunResult = yield* runDockerContainer('sui.fork', {
			image: { tag: image },
			env,
			network: networkName,
			networkAlias: SUI_FORK_NETWORK_ALIAS,
			routing: [
				{
					name: 'sui',
					entrypoint: 'sui-grpc',
					servicePort: FORK_GRPC_PORT,
					protocol: 'h2c',
				},
			],
		}).effect.pipe(
			Effect.catchTag('DockerError', (cause) =>
				Effect.fail(
					new SuiError({
						phase: 'sui-up',
						message: `failed to start sui-fork container (upstream=${upstream})`,
						cause,
					}),
				),
			),
			Effect.catchTag('ReadyProbeError', (cause) =>
				Effect.fail(
					new SuiError({
						phase: 'sui-up',
						message: `sui-fork container failed ready probe (upstream=${upstream})`,
						cause,
					}),
				),
			),
		);
		void forkRunResult;

		// Host-side URL goes through traefik. Container-side peers
		// reach the fork via the docker-DNS alias `sui-fork` on
		// `networkName`. The fork serves gRPC over h2c (HTTP/2 plain),
		// but the URL scheme exposed to JS callers is `http://` because
		// Traefik does the protocol translation; the SDK's
		// `GrpcWebFetchTransport` speaks gRPC-Web over fetch, which is
		// HTTP/1.1-friendly.
		const rpcUrl = `http://${hostnameRpc}:${grpcEntrypointPort}`;
		const containerRpcUrl = `http://${SUI_FORK_NETWORK_ALIAS}:${FORK_GRPC_PORT}`;

		const baseClient = new SuiGrpcClient({ baseUrl: rpcUrl, network: upstream });

		// Ready probe — first a TCP/HTTP socket check, then a
		// `ForkingService.GetStatus` round trip to confirm the
		// initialization-phase upstream warming completed. 180s budget
		// matches R10 — cold-start `sui-fork start` serially fetches
		// system state objects against the upstream GraphQL endpoint,
		// which is slow.
		const readyTimeoutMs = options.readyTimeoutMs ?? 180_000;
		yield* setPhase('awaiting sui-fork rpc + GetStatus');
		const statusProbe = Effect.tryPromise({
			try: () => baseClient.forkingService.getStatus({}).response,
			catch: (cause) => new Error(`fork.status: ${stringifyCause(cause)}`),
		});
		const initialStatus = yield* statusProbe.pipe(
			Effect.retry(Schedule.spaced('2 seconds')),
			Effect.timeoutOrElse({
				duration: `${readyTimeoutMs} millis`,
				orElse: () =>
					Effect.fail(
						new SuiError({
							phase: 'ready-probe',
							message:
								`sui-fork did not respond to ForkingService.GetStatus within ${readyTimeoutMs}ms ` +
								`(upstream=${upstream}, rpc=${rpcUrl}). Cold-start warming the upstream system ` +
								`state can be slow — increase \`SuiForkOptions.readyTimeoutMs\` if your network ` +
								`to the upstream GraphQL is high-latency.`,
						}),
					),
			}),
			Effect.mapError((cause) =>
				cause instanceof SuiError
					? cause
					: new SuiError({
							phase: 'ready-probe',
							message: `sui-fork ready probe failed: ${cause.message}`,
							cause,
						}),
			),
		);
		const forkedAtCheckpoint = Number(initialStatus.forkedAtCheckpoint);

		yield* publishEndpoint({ name: EndpointName.SUI_RPC, url: rpcUrl, kind: 'rpc' });

		// Real chain id, NOT the forked snapshot's checkpoint number.
		// The fork serves the upstream's chain id verbatim so dapp-kit
		// MVR + wallet-standard validation think they're talking to
		// the real chain (which they essentially are, at a frozen
		// checkpoint). D1 in `notes/sui-fork-integration.md`.
		const chainId = yield* fetchChainId(baseClient);
		yield* publishSuiState({ name: `sui.${network}`, chainId });

		// Wrap the client with the R1 guard Proxy. Every downstream
		// consumer (`Account`, `Package`, dapp-kit codegen at runtime)
		// reads through this single guarded handle.
		const client = forkGuard(baseClient);

		// Phase 5 Subtopic 3 (P5.5) — auto-tick clock. The supervisor's
		// scope binds the fiber, so a wipe / restart / Ctrl-C tears the
		// fiber down alongside the container. `autoTickMs` was resolved
		// above (folding the on-disk `runtime.autoTickMs` carry per
		// P5.5.4 in as a fallback when the caller didn't re-pass
		// `autoTick`); `undefined` means auto-tick stays off. We log
		// ONCE at acquire (no per-tick chatter — the WARN-on-failure
		// path in `runAutoTickClock` covers anomalies).
		if (autoTickMs !== undefined) {
			yield* setPhase(`starting auto-tick clock (${autoTickMs}ms)`);
			yield* runAutoTickClock({ client, intervalMs: autoTickMs });
			yield* Effect.logInfo(`sui-fork: auto-tick active (${autoTickMs}ms)`);
		}

		const fork = buildForkControl(client, upstream, forkedAtCheckpoint, seedAddrs, autoTickMs);

		// `waitForTransactionsReady` is a no-op on fork mode — there's
		// no faucet, and the fork is funds-transferable as soon as
		// `GetStatus` reports the upstream system state is warmed
		// (which is what the ready probe above gates on).
		const waitForTransactionsReady = () => Effect.void;

		const rpc: Endpoint = {
			host: rpcUrl,
			container: containerRpcUrl,
			containerNetworks: [networkName],
		};

		return {
			network,
			rpc,
			client,
			chainId,
			waitForTransactionsReady,
			runtime: 'forked',
			fork,
		} satisfies Sui;
	})();

	const tag = provide(SuiTag, build, {
		kind: 'service',
		plugin: 'sui',
		displayTitle: `sui.${network}`,
		display: (s) => {
			const endpoints: Array<{ readonly label: string; readonly url: string }> = [
				{ label: 'grpc', url: s.rpc.host },
			];
			return {
				title: `sui.${s.network}`,
				...(endpoints.length > 1 ? { endpoints } : { primary: s.rpc.host }),
			};
		},
		// Phase B: the fork builder yields `Identity` (a Context.Service)
		// and the sibling `forkImage` LayeredTag. The sibling is folded
		// into `__layers` (mirrors how walrus treats `upstreamImage`) and
		// doesn't enter `__upstreamKeys` — the fork variant is a leaf from
		// the stack graph's perspective.
		upstreamKeys: [],
	});

	// Surface the fork image layer alongside the service tag — mirrors
	// `buildLocalnet`'s `__layers` shape so the supervisor schedules the
	// image build before the service body. `forkImage` is always defined
	// post-Phase 3.8.
	const baseLayers: ReadonlyArray<Layer.Layer<any, any, any>> = [
		...forkImage.__layers,
		tag.__layer,
	];

	// Also expose `SuiBuildImage` so `publishMove` `docker exec`s into
	// THIS image for `sui move build`. The `sui-fork-image/` Dockerfile
	// ships the real `sui` binary alongside `sui-fork`, so move builds
	// work without a separate `sui-image` build.
	const buildImageLayer = Layer.effect(
		SuiBuildImage,
		Effect.gen(function* () {
			const img = yield* forkImage;
			return { tag: img.tag };
		}),
	);
	const layers: ReadonlyArray<Layer.Layer<any, any, any>> = [
		...baseLayers,
		buildImageLayer as unknown as Layer.Layer<any, any, any>,
		SuiBuildContainerLive as Layer.Layer<any, any, any>,
	];
	return Object.assign(tag, { __layers: layers });
};

// -----------------------------------------------------------------------------
// Factory
// -----------------------------------------------------------------------------

/** The canonical sui factory. Returns a LayeredTag that's both an Effect Layer
 *  and an Effect tag (`yield* Sui` gives the `Sui`).
 *
 *  Defaults to whatever `DEVSTACK_NETWORK` resolves to (`localnet` when
 *  unset). The CLI `--network` flag and the `devstack({ network })`
 *  config option both flow through that env var. Pass `{ network: {
 *  rpc, faucet } }` for a custom RPC (corporate fullnode, pinned fork);
 *  pass `{ network: 'testnet' }` to pin in code regardless of env var. */
export const Sui = (opts: SuiOptions = {}): LayeredTag<'@devstack/SuiTag', Sui> => {
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
	} else if (net === 'mainnet-fork' || net === 'testnet-fork' || net === 'devnet-fork') {
		member = buildFork(opts.fork ?? {}, net);
	} else {
		member = buildLocalnet(opts.localnet ?? {});
	}
	return makeService('sui', 'service', member) as unknown as LayeredTag<'@devstack/SuiTag', Sui>;
};
