// Regression: router boot() must run the expensive bootstrap (docker
// inspect + 4-way decision) EXACTLY ONCE under concurrent callers.
//
// Background — commit b8f49591. Two plugins can acquire the router in
// parallel, calling `boot()` from two fibers. The bug: both fibers read
// `bootRef` (line ~684) and observe `null` BEFORE the long critical
// section, then both serialize through the dispatch lock and BOTH ran
// bootstrap — paying `docker inspect` twice and (worse) re-running the
// destructive 4-way decision a second time after the first boot already
// created/adopted the container.
//
// The fix added two things inside `boot()`:
//   (a) a re-check of `bootRef` IMMEDIATELY AFTER acquiring the dispatch
//       lock (`bootedByPeer`), so the second fiber short-circuits, and
//   (b) the `Ref.set(bootRef, …)` now lives INSIDE the locked scope, so
//       the winner publishes the cached report while still holding the
//       lock — guaranteeing the loser's post-lock re-check observes it.
//
// The existing `service.test.ts` "boot() is idempotent" test only
// exercises the SEQUENTIAL fast-path (second call after the first fully
// returned), which passes on pre-fix code too. This file pins the
// CONCURRENT path.
//
// Seam counted: `TraefikContainerOps.inspectContainer`. `bootstrap()`
// calls it exactly once per invocation, and only from inside the locked
// critical section — so its invocation count == the number of times the
// expensive bootstrap actually ran. Pre-fix: 2. Post-fix: 1.
//
// Determinism: a counting stub parks the FIRST `inspectContainer` call on
// a Deferred. That guarantees fiber A is suspended INSIDE bootstrap —
// holding the dispatch lock, with `bootRef` still null — before fiber B
// is ever forked. Fiber B then runs straight through boot()'s pre-lock
// `bootRef` read (observes null, exactly the pre-fix precondition) and
// blocks contending for the dispatch lock. Only then do we release fiber
// A. The lock's backoff retries on the LIVE clock (`underLiveClock`), so
// fiber B makes progress under `it.effect`'s TestClock — same property
// the cross-process lock concurrency tests rely on.

import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem';
import { Deferred, Effect, Fiber, Layer, Ref } from 'effect';
import { afterAll, describe, expect, it } from '@effect/vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { layerEntrypointRegistry } from '../../../src/orchestrators/router/entrypoints.ts';
import type { RouterProfile } from '../../../src/orchestrators/router/profile.ts';
import {
	layerRouterConfigLiteral,
	layerRouterService,
	RouterService,
	UpstreamResolverService,
} from '../../../src/orchestrators/router/service.ts';
import {
	TraefikContainerOpsService,
	type InspectedTraefikContainer,
	type TraefikContainerOps,
} from '../../../src/orchestrators/router/traefik-container.ts';
import { appName, stackName } from '../../../src/substrate/brand.ts';
import { layerIdentity } from '../../../src/substrate/runtime/paths.ts';

// Per-test temp dirs swept once at the end of the file — same array-and-
// sweep idiom as `service.test.ts`.
const allocatedTmpDirs: string[] = [];
afterAll(() => {
	for (const dir of allocatedTmpDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

const makeTmpDir = (): string => {
	const dir = mkdtempSync(join(tmpdir(), 'devstack-router-boot-concurrency-'));
	allocatedTmpDirs.push(dir);
	return dir;
};

const upstreamsLayer = Layer.succeed(UpstreamResolverService)({
	resolveContainer: (target) => Effect.succeed({ host: '172.20.0.5', port: target.containerPort }),
	resolveHostLoopback: (target) => Effect.succeed({ host: '127.0.0.1', port: target.port }),
});

const identity = {
	app: appName('my-app'),
	stack: stackName('main'),
	network: 'localnet',
};
const identityLayer = layerIdentity(identity);

const registryLayer = layerEntrypointRegistry([
	{ name: 'wallet-app', port: 6173, protocol: 'http' },
]);

const makeTestProfile = (dispatchDir: string): RouterProfile => ({
	version: 1,
	id: 'test-profile',
	userId: 'test-user',
	dockerContextId: 'test-docker',
	stateDir: join(dispatchDir, '..'),
	dispatchDir,
	containerName: 'devstack-router-test',
	networkName: 'devstack-router-test',
	bootstrapLockFile: join(dispatchDir, 'locks', 'bootstrap.lock'),
	dispatchLockFile: join(dispatchDir, 'locks', 'dispatch.lock'),
});

// The count discriminator: `bootstrap()` calls `inspectContainer` once
// per invocation, so a count of 2 means both fibers ran the expensive
// critical section (pre-fix), a count of 1 means the loser short-circuited
// on the post-lock `bootRef` re-check (post-fix). We deliberately count
// `inspectContainer` rather than `createFresh`/`ensureNetwork`: it is the
// single op that runs on EVERY bootstrap path before any decision branch,
// so it is the cleanest once-per-bootstrap probe.
describe('RouterService.boot (concurrent)', () => {
	it.effect('runs bootstrap exactly once when two fibers boot() in parallel', () =>
		Effect.gen(function* () {
			const dir = makeTmpDir();
			const profile = makeTestProfile(dir);
			const entered = yield* Deferred.make<void>();
			const release = yield* Deferred.make<void>();
			const inspectCount = yield* Ref.make(0);

			const ops: TraefikContainerOps = {
				ensureNetwork: (_name) => Effect.succeed({ id: 'stub-network' }),
				inspectContainer: (_name): Effect.Effect<InspectedTraefikContainer | null> =>
					Effect.gen(function* () {
						const n = yield* Ref.updateAndGet(inspectCount, (prev) => prev + 1);
						if (n === 1) {
							// Fiber A is now provably INSIDE bootstrap, holding the
							// dispatch lock, with `bootRef` still null. Park it.
							yield* Deferred.succeed(entered, undefined);
							yield* Deferred.await(release);
						}
						return null;
					}),
				createFresh: (_args) => Effect.succeed({ id: 'stub-container' }),
				resume: (_name) => Effect.succeed({ id: 'stub-container' }),
				forceRemove: (_name) => Effect.succeed(undefined),
			};

			const layer = layerRouterService.pipe(
				Layer.provideMerge(
					Layer.mergeAll(
						identityLayer,
						registryLayer,
						Layer.succeed(TraefikContainerOpsService)(ops),
						upstreamsLayer,
						NodeFileSystem.layer,
						layerRouterConfigLiteral({ disabled: false, profile, image: 'traefik:v3.5' }),
					),
				),
			);

			const reports = yield* Effect.gen(function* () {
				const router = yield* RouterService;

				// Fiber A: starts boot, parks inside the FIRST inspectContainer
				// (holding the dispatch lock, bootRef still null).
				const fiberA = yield* Effect.forkChild(router.boot());

				// Wait until A is provably parked inside bootstrap.
				yield* Deferred.await(entered);

				// Fiber B: forked AFTER A is parked. B runs straight through
				// boot()'s pre-lock `bootRef` read — which observes `null`
				// (A has not set it yet; that is exactly the pre-fix
				// precondition) — and then blocks contending for the dispatch
				// lock that A holds. The synchronous run from fork to the
				// lock's first (failed) attempt cannot suspend before the
				// pre-lock read, so a single scheduler turn guarantees B is
				// past line ~684 before we release A.
				const fiberB = yield* Effect.forkChild(router.boot());
				yield* Effect.yieldNow;
				yield* Effect.yieldNow;

				// Release A. A finishes inspectContainer → bootstrap → sets
				// bootRef INSIDE the lock → releases both locks. B then wins
				// the dispatch lock and (post-fix) observes the non-null
				// bootRef in its post-lock re-check, skipping bootstrap.
				yield* Deferred.succeed(release, undefined);

				const reportA = yield* Fiber.join(fiberA);
				const reportB = yield* Fiber.join(fiberB);
				return { reportA, reportB };
			}).pipe(Effect.provide(layer));

			const count = yield* Ref.get(inspectCount);
			// Pre-fix: 2 (both fibers ran the expensive bootstrap critical
			// section). Post-fix: 1 (the loser short-circuited on the
			// post-lock bootRef re-check).
			expect(count).toBe(1);
			// Both callers observe the SAME cached report (idempotent across
			// the concurrent path, not just the sequential one).
			expect(reports.reportA.decision).toBe('recreate-fresh');
			// The fix sets `bootRef` inside the lock and the loser returns
			// that very object — so identity equality is the precise pin.
			expect(reports.reportB).toBe(reports.reportA);
		}),
	);
});
