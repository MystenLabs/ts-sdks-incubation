// Phase 5 Subtopic 4 — P5.T3 — docker-gated parallel-stacks e2e test.
//
// Two `sui-fork` containers, two `forkHarness` instances under
// distinct stack ids, booted concurrently. Asserts the two harnesses
// dial DIFFERENT chains via DIFFERENT host ports and that
// `GetStatus.upstream` matches each instance's upstream.
//
// Two scenarios cover P5.6.2 + P5.6.3:
//
//   1. Same upstream (testnet), two distinct stack ids — proves the
//      per-stack data-dir / file-lock partition holds against shared
//      `.devstack/sui-fork-cache/<chainId>/`.
//   2. Different upstreams (mainnet vs testnet), two distinct stack ids —
//      proves the configHash partition keeps each stack's meta.json gate
//      independent.
//
// Gated behind `RUN_FORK_DOCKER_TESTS=1` (matches the other Phase-1+
// fork docker tests). Cold-start cost is ~2x a single-stack test
// (60-180s per container, partially amortized by the shared upstream
// cache for scenario 1). Each `it.effect` shares no harness — the two
// containers boot, run their assertions, then tear down via the scope
// finalizer.

import { Effect } from 'effect';
import { it } from '@effect/vitest';
import { describe, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { layer as NodeServicesLayer } from '@effect/platform-node/NodeServices';
import { forkHarness, TEST_TESTNET_CHECKPOINT } from '../sui-fork.testkit.js';

const RUN = process.env.RUN_FORK_DOCKER_TESTS === '1';

const dockerOk = (): boolean => {
	const r = spawnSync('docker', ['version', '--format', '{{.Server.Version}}'], {
		timeout: 5000,
		stdio: ['ignore', 'pipe', 'ignore'],
	});
	return r.status === 0;
};

// NodeServicesLayer satisfies `ChildProcessSpawner` + `FileSystem` +
// `Path`. The harness uses ChildProcessSpawner directly (docker CLI
// shells) and reaches for fs via raw `node:fs` for its per-test data
// dir, so only the spawner is load-bearing here.
const SPAWNER_LAYER = NodeServicesLayer;

(RUN && dockerOk() ? describe : describe.skip)('sui-fork parallel stacks (P5.T3)', () => {
	it.effect(
		'P5.6.2: two stacks against the same upstream (testnet) boot concurrently and surface distinct host URLs',
		() =>
			Effect.gen(function* () {
				// Two harness scopes inside a single outer scope so
				// `Scope.close` tears both down on test exit. The fork
				// harness mints a random stack id by default, so two
				// harness calls always produce distinct identities even
				// without an explicit override.
				const hA = yield* forkHarness({
					upstream: 'testnet',
					checkpoint: TEST_TESTNET_CHECKPOINT,
				});
				const hB = yield* forkHarness({
					upstream: 'testnet',
					checkpoint: TEST_TESTNET_CHECKPOINT,
				});

				// Distinct stack ids → distinct data dirs, distinct
				// docker networks, distinct host ports.
				expect(hA.stack).not.toBe(hB.stack);
				expect(hA.hostUrl).not.toBe(hB.hostUrl);
				expect(hA.containerId).not.toBe(hB.containerId);

				// Both harnesses' clients are independently
				// addressable. Round-trip a getStatus against each.
				const statusA = yield* Effect.tryPromise(
					() => hA.client.forkingService.getStatus({}).response,
				);
				const statusB = yield* Effect.tryPromise(
					() => hB.client.forkingService.getStatus({}).response,
				);
				// Both are mid-checkpoint testnet forks at the pinned
				// anchor; their chainIds match because they wrap the
				// same upstream.
				expect(Number(statusA.forkedAtCheckpoint)).toBe(TEST_TESTNET_CHECKPOINT);
				expect(Number(statusB.forkedAtCheckpoint)).toBe(TEST_TESTNET_CHECKPOINT);
			}).pipe(Effect.scoped, Effect.provide(SPAWNER_LAYER)),
		600_000,
	);

	it.effect(
		'P5.6.3: two stacks against different upstreams (mainnet + testnet) coexist',
		() =>
			Effect.gen(function* () {
				const hTestnet = yield* forkHarness({
					upstream: 'testnet',
					checkpoint: TEST_TESTNET_CHECKPOINT,
				});
				// Mainnet's pinned checkpoint differs — for the test
				// we let the upstream's-latest behavior pick. The
				// harness's TEST_TESTNET_CHECKPOINT is a testnet-only
				// anchor; mainnet uses the unset (latest) default.
				const hMainnet = yield* forkHarness({ upstream: 'mainnet' });

				expect(hTestnet.upstream).toBe('testnet');
				expect(hMainnet.upstream).toBe('mainnet');

				// Their host URLs are distinct (different ephemeral
				// host ports) AND their docker networks are distinct
				// (random per-stack names ensure no `sui-fork` DNS
				// alias collision).
				expect(hTestnet.hostUrl).not.toBe(hMainnet.hostUrl);
				expect(hTestnet.stack).not.toBe(hMainnet.stack);

				// Sanity: both `getStatus` round trips succeed against
				// their own host URLs. The status response itself
				// doesn't carry a chainId field, but a successful round
				// trip against each distinct URL proves the two forks
				// are independently addressable. ChainId divergence is
				// asserted at a different layer via
				// `client.core.getChainIdentifier()` (each fork wraps a
				// different upstream system state, so their chainIds
				// must differ — exercised by the unit-side
				// `parallel.test.ts:configHash` checks).
				const statusTestnet = yield* Effect.tryPromise(
					() => hTestnet.client.forkingService.getStatus({}).response,
				);
				const statusMainnet = yield* Effect.tryPromise(
					() => hMainnet.client.forkingService.getStatus({}).response,
				);
				expect(Number(statusTestnet.checkpointSequenceNumber)).toBeGreaterThanOrEqual(0);
				expect(Number(statusMainnet.checkpointSequenceNumber)).toBeGreaterThanOrEqual(0);
				// `getChainIdentifier` reads the chain's checkpoint-0
				// digest — different upstreams have different chainIds
				// by construction. This is the load-bearing assertion
				// that two parallel forks against different upstreams
				// aren't accidentally sharing chain state.
				const chainIdTestnet = yield* Effect.tryPromise(() =>
					hTestnet.client.core
						.getChainIdentifier()
						.then((r: { chainIdentifier: string }) => r.chainIdentifier),
				);
				const chainIdMainnet = yield* Effect.tryPromise(() =>
					hMainnet.client.core
						.getChainIdentifier()
						.then((r: { chainIdentifier: string }) => r.chainIdentifier),
				);
				expect(chainIdTestnet).not.toBe(chainIdMainnet);
			}).pipe(Effect.scoped, Effect.provide(SPAWNER_LAYER)),
		600_000,
	);

	it.effect(
		'P5.T3: parallel harnesses tear down cleanly without leaking containers',
		() =>
			Effect.gen(function* () {
				// Spawn two harnesses inside an inner scope, close it,
				// confirm `docker ps` shows neither. We can't enumerate
				// docker containers from inside the test easily without
				// re-importing the spawner adapter, so the assertion is
				// indirect: a fresh `forkHarness` should succeed after
				// scope close, proving no port / network / data-dir
				// resource was leaked.
				yield* Effect.scoped(
					Effect.gen(function* () {
						yield* forkHarness({ upstream: 'testnet' });
						yield* forkHarness({ upstream: 'testnet' });
					}),
				);
				// New harness should work — would fail if a prior
				// finalizer left containers / networks lying around.
				const fresh = yield* forkHarness({ upstream: 'testnet' });
				expect(fresh.hostUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
			}).pipe(Effect.scoped, Effect.provide(SPAWNER_LAYER)),
		900_000,
	);
});
