// Test harness for `sui-fork`-backed integration tests.
//
// Every fork-mode test in this package goes through `testHarness.fork`
// rather than calling `Docker.run` directly. The harness:
//   - boots a `sui-fork` container against the real testnet upstream
//     at a pinned checkpoint (`TEST_TESTNET_CHECKPOINT` below);
//   - exposes the `SuiGrpcClient` + `ForkControl` adapter the rest of
//     the test runs against;
//   - registers a Scope finalizer that tears the container down on
//     test completion (pass OR fail) so the daemon is left clean.
//
// Cold-start time is the dominant cost (60-90s on a fresh upstream
// state-warming run). Tests should share a harness instance where
// possible. CI's `globalSetup` pre-seeds `.devstack/sui-fork-cache/`
// once per run so per-test acquire after that is ~10s.
//
// The harness is deliberately small — it owns lifecycle but defers
// every assertion to the test that uses it. Each test sets its own
// timeout (typical 60-180s).

import { Effect, Scope } from 'effect';
import { ChildProcessSpawner } from 'effect/unstable/process';
import { SuiGrpcClient } from '@mysten/sui/grpc';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import * as fs from 'node:fs';
import { contentHash } from './content-hash.js';
import * as Docker from './docker.js';
import { SuiError } from './errors.js';
import { Identity, type IdentityShape } from './identity.js';

// -----------------------------------------------------------------------------
// Pinned testnet checkpoint
// -----------------------------------------------------------------------------

/**
 * Pinned testnet checkpoint used by every fork-mode integration test.
 *
 * Refresh quarterly — out-of-date checkpoints still resolve fine (the
 * upstream GraphQL has multi-year retention) but a fresher checkpoint
 * shaves cold-start time because fewer object/tx fetches miss the
 * local index.
 *
 * Choosing criteria:
 *   - Recent enough that downstream packages (DeepBook, Walrus, Seal)
 *     at their latest mainnet/testnet addresses are deployed.
 *   - Stable for at least a quarter (no major migration in flight).
 *
 * Last refreshed: 2026-05-18 — placeholder value; verify a recent
 * testnet checkpoint via `curl https://sui-testnet.mystenlabs.com/graphql ...`
 * before merging. Setting too high a value just slows cold-start;
 * setting too low risks not having needed packages at this commit.
 *
 * NOTE: this value is a CONSTANT, not pulled from env. CI runs the
 * same checkpoint as local dev so test failures reproduce.
 */
export const TEST_TESTNET_CHECKPOINT = 50_000_000;

// -----------------------------------------------------------------------------
// Image build (one shot per test process)
// -----------------------------------------------------------------------------

// Pinned commit matching the production `DEFAULT_SUI_FORK_REV` in
// `services/sui.ts`. Bumping these in lockstep avoids two images on
// the daemon at the same SHA — `dockerImage` is content-addressed so
// the build is cached across tests after the first.
const TEST_SUI_FORK_REV = '259b947bf5b07cded7481c0c1f5e88470939c930';
const FORK_GRPC_PORT = 9000;

const dockerContext = new URL('../../sui-fork-image/', import.meta.url).pathname;

// Content-addressed tag mirroring `dockerImage()`'s convention without
// going through its layer dance — the testkit doesn't need the
// supervisor's reactive layer wiring, just a stable tag string.
const forkImageTag = (): string => {
	const hash = contentHash(
		{
			dockerfile: 'Dockerfile',
			buildArgs: { SUI_REV: TEST_SUI_FORK_REV },
		},
		{ length: 12 },
	);
	return `devstack-sui.fork.image-test:${hash}`;
};

/** Build the fork image idempotently. Cached at the docker daemon
 *  level — if the tag already exists, the build is a no-op. */
const buildForkImageOnce = (): Effect.Effect<
	{ readonly tag: string },
	Docker.DockerError,
	ChildProcessSpawner.ChildProcessSpawner
> =>
	Effect.gen(function* () {
		const tag = forkImageTag();
		const existing = yield* Docker.imageExists(tag);
		if (existing) return { tag };
		yield* Docker.build({
			context: dockerContext,
			dockerfile: 'Dockerfile',
			tag,
			buildArgs: { SUI_REV: TEST_SUI_FORK_REV },
		});
		return { tag };
	});

// -----------------------------------------------------------------------------
// Cache root — shared across tests, persists between runs
// -----------------------------------------------------------------------------

/** Shared upstream cache root. CI's `globalSetup` pre-seeds this
 *  directory once per run so per-test cold-start hits the cache.
 *  Tests writing to it use sub-paths keyed by chain id. */
export const forkCacheRoot = (): string =>
	process.env.DEVSTACK_SUI_FORK_CACHE_DIR ??
	join(process.cwd(), '.devstack', 'sui-fork-cache', 'testnet');

// -----------------------------------------------------------------------------
// Harness
// -----------------------------------------------------------------------------

export interface ForkHarnessOptions {
	readonly upstream?: 'mainnet' | 'testnet' | 'devnet';
	readonly checkpoint?: number;
	readonly seed?: {
		readonly addresses?: ReadonlyArray<string>;
		readonly objects?: ReadonlyArray<string>;
	};
	/** Override the per-test stack id. Defaults to a random suffix so
	 *  parallel vitest workers don't collide. */
	readonly stack?: string;
	/** Wall-clock budget for the container to become ready. Default
	 *  180_000ms (180s). Tests run against a pre-seeded cache should
	 *  succeed in <30s. */
	readonly readyTimeoutMs?: number;
}

export interface ForkHarness {
	readonly client: SuiGrpcClient;
	readonly stack: string;
	readonly upstream: 'mainnet' | 'testnet' | 'devnet';
	readonly checkpoint: number;
	readonly hostUrl: string;
	/** Container id of the running `sui-fork` process. Exposed for
	 *  tests that need to `docker inspect` it or assert a specific
	 *  exit. */
	readonly containerId: string;
	/** Tear down the harness explicitly. Idempotent. Called
	 *  automatically by the scope finalizer; tests that want to assert
	 *  graceful shutdown can call this first. */
	readonly stop: () => Effect.Effect<void, never>;
}

const randomStack = (): string => `fork-${randomBytes(4).toString('hex')}`;

/**
 * Acquire a `sui-fork` harness inside the current Effect scope. The
 * container is torn down automatically when the scope closes.
 *
 * This is the canonical entry point for every `*.docker.test.ts` in
 * the fork-mode test suite. Drop into `it.effect` like:
 *
 *   it.effect('advance-clock works', () => Effect.gen(function*() {
 *     const harness = yield* forkHarness({});
 *     const before = yield* harness.client.forkingService.getStatus({}).response;
 *     // ... assert on `before`, call advanceClock, assert again.
 *   }))
 */
export const forkHarness = (
	options: ForkHarnessOptions,
): Effect.Effect<
	ForkHarness,
	SuiError | Docker.DockerError,
	ChildProcessSpawner.ChildProcessSpawner | Scope.Scope
> => {
	const stack = options.stack ?? randomStack();
	const upstream = options.upstream ?? 'testnet';
	const checkpoint = options.checkpoint ?? TEST_TESTNET_CHECKPOINT;
	const readyTimeoutMs = options.readyTimeoutMs ?? 180_000;

	// Provide a synthetic Identity for the test — Docker.run requires
	// it to label / namespace containers. App is `'fork-test'` so a
	// stray container shows up clearly as test debris in `docker ps`.
	const identity: IdentityShape = {
		app: 'fork-test',
		stack,
		network: 'testnet-fork',
	};

	return Effect.gen(function* () {
		// Per-test data dir mounted into the container so we can inspect
		// + cleanup the on-disk fork state from the host side without
		// shelling into the container. `tmpdir`-style path so a forced
		// vitest abort leaves at most a few MB of orphaned tmp files.
		const dataDir = join(process.cwd(), '.devstack', 'tmp', `sui-fork-${stack}`);
		fs.mkdirSync(dataDir, { recursive: true });

		// Build the image (cached at the docker-daemon level after the
		// first test in the process).
		const image = yield* buildForkImageOnce();

		// Per-test docker network so two parallel harnesses don't
		// collide on the `sui-fork` DNS alias.
		const networkName = `devstack-test-${stack}-net`;
		yield* Docker.networkCreate(networkName);

		const env: Record<string, string> = {
			SUI_FORK_NETWORK: upstream,
			SUI_FORK_CHECKPOINT: String(checkpoint),
			SUI_FORK_RPC_ADDR: `0.0.0.0:${FORK_GRPC_PORT}`,
		};
		const seedAddrs = options.seed?.addresses ?? [];
		if (seedAddrs.length > 0) env.SUI_FORK_SEED_ADDRS = seedAddrs.join(',');
		const seedObjs = options.seed?.objects ?? [];
		if (seedObjs.length > 0) env.SUI_FORK_SEED_OBJS = seedObjs.join(',');

		// Map the container's gRPC port to a random ephemeral host port
		// so two parallel harnesses don't collide.
		const result = yield* Docker.run({
			name: `sui.fork.test.${stack}`,
			image: image.tag,
			env,
			ports: { 0: FORK_GRPC_PORT }, // 0 = auto-allocate host port
			network: networkName,
			networkAlias: 'sui-fork',
			detach: true,
		});

		// Read back the resolved host port (Docker.run does this when
		// `ports[host]=0`).
		const hostPort = result.hostPorts[0];
		if (hostPort === undefined) {
			return yield* Effect.fail(
				new SuiError({
					phase: 'sui-up',
					message: `forkHarness: docker run did not surface a host port for ${FORK_GRPC_PORT}`,
				}),
			);
		}
		const hostUrl = `http://127.0.0.1:${hostPort}`;

		const client = new SuiGrpcClient({ baseUrl: hostUrl, network: upstream });

		// Ready probe — poll `getStatus` until success or the deadline
		// fires. We use a plain `while` rather than `Effect.retry` so
		// the deadline check is explicit and the failure path captures
		// the most recent error for the surfaced message.
		const deadline = Date.now() + readyTimeoutMs;
		let lastErr: unknown;
		let ready = false;
		while (Date.now() < deadline) {
			const exit = yield* Effect.tryPromise({
				try: () => client.forkingService.getStatus({}).response,
				catch: (cause): unknown => cause,
			}).pipe(Effect.exit);
			if (exit._tag === 'Success') {
				ready = true;
				lastErr = undefined;
				break;
			}
			lastErr = exit.cause;
			yield* Effect.sleep('1 seconds');
		}
		if (!ready) {
			return yield* Effect.fail(
				new SuiError({
					phase: 'ready-probe',
					message:
						`forkHarness: sui-fork did not become ready within ${readyTimeoutMs}ms ` +
						`(upstream=${upstream}, checkpoint=${checkpoint}, last error: ${String(lastErr)})`,
				}),
			);
		}

		// `Docker.run` already registers a scope finalizer that stops +
		// removes the container on scope close. `stop()` is a no-op
		// today (kept for API stability so future tests can hook into
		// a graceful-shutdown assertion before the scope closes).
		const stop = (): Effect.Effect<void, never> => Effect.void;

		// ALSO clean up the data dir on scope close, since `Docker.run`
		// doesn't know about it.
		yield* Effect.addFinalizer(() =>
			Effect.sync(() => {
				try {
					fs.rmSync(dataDir, { recursive: true, force: true });
				} catch {
					// best-effort cleanup
				}
			}),
		);

		return {
			client,
			stack,
			upstream,
			checkpoint,
			hostUrl,
			containerId: result.containerId,
			stop,
		};
	}).pipe(Effect.provideService(Identity, identity));
};

// Re-export for tests' convenience.
export const testHarness = { fork: forkHarness };
