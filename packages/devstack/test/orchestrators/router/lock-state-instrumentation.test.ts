// Router dispatch-lock-across-probe regression cover (backlog #10a).
//
// The production fix in `src/orchestrators/router/service.ts` wraps
// `publishRouteFile + waitForPublicRouteReadiness` inside the same
// `Effect.scoped` block that calls `acquireStackLock`. Effect's Scope
// semantics guarantee the lock finalizer (unlinkSync) fires only when
// the scoped block closes — which is AFTER both operations complete.
//
// This file carries TWO layers of cover:
//
//   1. A BEHAVIORAL regression (the primary cover, at the bottom of the
//      file) that drives the REAL `contributeRoute` production path —
//      real `acquireStackLock` writing a real on-disk lock file, real
//      dispatch-file write, real scope finalizers. It parks the
//      readiness probe on a Deferred (the probe `fetch` is already a
//      first-class injectable seam) so a fiber is provably suspended
//      INSIDE the scoped lock block, mid-probe, and then asserts the
//      runtime guarantee directly: the on-disk dispatch lock file
//      EXISTS while the probe runs, and a concurrent contributor for a
//      different route cannot acquire the lock until the first releases.
//      If a refactor hoisted the probe outside the scoped block (the
//      exact regression), the lock would already be released when the
//      probe runs → the lock file would be absent → the test fails.
//
//      The original `concurrent-contribute-route.test.ts` raced real
//      fibers under `it.live + Promise gates + Effect.forkScoped` with
//      NO deterministic park — its readiness budget churned the live
//      clock and starved sibling vitest workers (Phase 2 #10 closing
//      notes). The behavioral cover below avoids that by parking on a
//      Deferred (the boot-concurrency.test.ts deterministic-park
//      technique): no fiber spins, the probe budget is generous, and the
//      lock contender blocks on the OS lock rather than busy-retrying.
//
//   2. A STRUCTURAL grep (kept as a cheap supplement) that pins the
//      source-level shape "acquireStackLock + publishRouteFile +
//      waitForPublicRouteReadiness inside a single Effect.scoped block".
//      It catches a probe hoisted outside the scoped block at the
//      cheapest possible cost and also guards the `boot()` two-lock
//      single-scope shape, which has no behavioral cover here.
//
// See STYLE_GUIDE §18 cross-process protocol for the codified rule.

import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem';
import { Deferred, Effect, Fiber, Layer, SubscriptionRef } from 'effect';
import { afterAll, describe, expect, it } from '@effect/vitest';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { layerEntrypointRegistry } from '../../../src/orchestrators/router/entrypoints.ts';
import {
	dispatchFilename,
	ROUTE_READINESS_HEADER,
} from '../../../src/orchestrators/router/file-provider.ts';
import { dispatchFileId } from '../../../src/orchestrators/router/hostname.ts';
import type { RouterProfile } from '../../../src/orchestrators/router/profile.ts';
import {
	layerRouterConfigLiteral,
	layerRouterService,
	RouterService,
	UpstreamResolverService,
} from '../../../src/orchestrators/router/service.ts';
import { layerTraefikContainerOpsStub } from '../../../src/orchestrators/router/traefik-container.ts';
import { appName, stackName } from '../../../src/substrate/brand.ts';
import type { HttpProbeFetch } from '../../../src/substrate/runtime/http-probe.ts';
import { layerIdentity } from '../../../src/substrate/runtime/paths.ts';

const ROUTER_SERVICE_PATH = new URL('../../../src/orchestrators/router/service.ts', import.meta.url)
	.pathname;

/** Strip line + block comments so doc-only `acquireStackLock` mentions
 *  in header comments don't trip the match. Naive — fine for TS source. */
const stripComments = (source: string): string =>
	source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');

/** Walk the source string from `start` matching balanced parens to find
 *  the end of the next call expression. Returns the inclusive end index
 *  of the matching `)`. */
const findBalancedClose = (source: string, openIdx: number): number => {
	let depth = 0;
	for (let i = openIdx; i < source.length; i += 1) {
		const ch = source[i];
		if (ch === '(') depth += 1;
		else if (ch === ')') {
			depth -= 1;
			if (depth === 0) return i;
		}
	}
	return -1;
};

describe('router contributeRoute dispatch-lock invariant', () => {
	it('holds the dispatch lock across publishRouteFile + waitForPublicRouteReadiness', () => {
		const source = stripComments(readFileSync(ROUTER_SERVICE_PATH, 'utf8'));

		// Find every `Effect.scoped(` call body.
		const scopedBodies: Array<string> = [];
		const scopedPattern = /Effect\.scoped\s*\(/g;
		for (const match of source.matchAll(scopedPattern)) {
			const openIdx = (match.index ?? 0) + match[0].length - 1;
			const closeIdx = findBalancedClose(source, openIdx);
			if (closeIdx > openIdx) {
				scopedBodies.push(source.slice(openIdx + 1, closeIdx));
			}
		}

		// The invariant: at least one scoped body must contain ALL three
		// of `acquireStackLock(`, `publishRouteFile`, and
		// `waitForPublicRouteReadiness(`. That body is the
		// contributeRoute critical section.
		const offenderBody = scopedBodies.find(
			(body) =>
				body.includes('acquireStackLock(') &&
				body.includes('publishRouteFile') &&
				body.includes('waitForPublicRouteReadiness('),
		);

		if (offenderBody === undefined) {
			throw new Error(
				'Router service `contributeRoute` no longer wraps ' +
					'`acquireStackLock + publishRouteFile + waitForPublicRouteReadiness` ' +
					'inside a single `Effect.scoped(...)` block. Without this shape the ' +
					'lock is released by Scope-finalizer before the readiness probe runs ' +
					'— a sibling contributor can publish over the half-staged file and ' +
					'Traefik serves stale content under the same dispatchFileId. ' +
					'See STYLE_GUIDE §18.',
			);
		}

		// Sanity-check: the scoped body must call `acquireStackLock` BEFORE
		// the first `publishRouteFile` reference, otherwise the lock is
		// acquired after the write and the invariant is meaningless.
		const acquireIdx = offenderBody.indexOf('acquireStackLock(');
		const publishIdx = offenderBody.indexOf('publishRouteFile');
		expect(acquireIdx).toBeGreaterThan(-1);
		expect(publishIdx).toBeGreaterThan(acquireIdx);

		// And the probe call must come AFTER the publish (and therefore
		// after the acquire), so the lock truly spans both.
		const probeIdx = offenderBody.indexOf('waitForPublicRouteReadiness(');
		expect(probeIdx).toBeGreaterThan(publishIdx);
	});

	it('contributeRoute does NOT have a scoped block that closes between publish and probe', () => {
		const source = stripComments(readFileSync(ROUTER_SERVICE_PATH, 'utf8'));

		// Find `contributeRoute` body and walk it for a forbidden shape:
		// an Effect.scoped block containing publishRouteFile but NOT
		// waitForPublicRouteReadiness.
		const contributeIdx = source.indexOf('const contributeRoute');
		expect(contributeIdx).toBeGreaterThan(-1);
		const contributeSlice = source.slice(contributeIdx);

		// Re-walk with matchAll for clarity.
		for (const match of contributeSlice.matchAll(/Effect\.scoped\s*\(/g)) {
			const openIdx = (match.index ?? 0) + match[0].length - 1;
			const closeIdx = findBalancedClose(contributeSlice, openIdx);
			if (closeIdx <= openIdx) continue;
			const body = contributeSlice.slice(openIdx + 1, closeIdx);
			if (body.includes('publishRouteFile') && !body.includes('waitForPublicRouteReadiness(')) {
				throw new Error(
					'Found an Effect.scoped block inside `contributeRoute` that contains ' +
						'`publishRouteFile` but NOT `waitForPublicRouteReadiness(...)` — the ' +
						'dispatch lock would be released before the readiness probe, ' +
						'violating STYLE_GUIDE §18.',
				);
			}
		}
	});
});

// boot() must hold dispatch + bootstrap locks under a SINGLE outer
// Effect.scoped — splitting them across two scopes opens a peer-write
// window between the scan that computes `protectedRouteLeaseIds` and the
// `bootstrap()` call that consumes them. A concurrent peer that publishes
// a new dispatch route file in that window would have its file silently
// invalidated by a stale `forceRemove` decision in `bootstrap`.
//
// Pinned structurally for the same reason `contributeRoute`'s invariant
// is: an `it.live` fiber-race test against real flock would starve
// sibling vitest workers, and a behavior mock of the substrate lock
// module is brittle. The single-scope shape IS what Effect.Scope
// semantics use to keep both locks held across the entire boot critical
// section. See STYLE_GUIDE §3 + §18.
describe('router boot dispatch-lock-spans-bootstrap invariant', () => {
	it('boot() holds both dispatch and bootstrap locks inside a single Effect.scoped block', () => {
		const source = stripComments(readFileSync(ROUTER_SERVICE_PATH, 'utf8'));

		// Locate the boot lambda body — start at `const boot:` and slice
		// forward to the next `const contributeRoute` (the next top-level
		// member) so we only inspect boot's source span.
		const bootStart = source.indexOf('const boot:');
		expect(bootStart).toBeGreaterThan(-1);
		const contributeStart = source.indexOf('const contributeRoute', bootStart);
		expect(contributeStart).toBeGreaterThan(bootStart);
		const bootSlice = source.slice(bootStart, contributeStart);

		// Walk every Effect.scoped(...) call inside boot.
		const scopedBodies: Array<string> = [];
		for (const match of bootSlice.matchAll(/Effect\.scoped\s*\(/g)) {
			const openIdx = (match.index ?? 0) + match[0].length - 1;
			const closeIdx = findBalancedClose(bootSlice, openIdx);
			if (closeIdx > openIdx) {
				scopedBodies.push(bootSlice.slice(openIdx + 1, closeIdx));
			}
		}

		// The invariant: at least one scoped body inside boot must contain
		// BOTH `acquireStackLock(profile.dispatchLockFile,` AND
		// `acquireStackLock(profile.bootstrapLockFile,` AND `bootstrap({`.
		// If they live in separate scoped bodies, a peer-write window
		// opens between the dispatch-lock scope close and the bootstrap-
		// lock scope acquire.
		const unifiedBody = scopedBodies.find(
			(body) =>
				body.includes('acquireStackLock(profile.dispatchLockFile,') &&
				body.includes('acquireStackLock(profile.bootstrapLockFile,') &&
				body.includes('bootstrap({'),
		);

		if (unifiedBody === undefined) {
			throw new Error(
				'Router `boot()` no longer wraps `acquireStackLock(dispatchLockFile) + ' +
					'acquireStackLock(bootstrapLockFile) + bootstrap(...)` inside a single ' +
					'`Effect.scoped(...)` block. Splitting these across two scopes lets a ' +
					'concurrent peer publish a new dispatch route file between the scan and ' +
					'the bootstrap decision; the live peer’s route is then silently invalidated ' +
					'by a stale `protectedRouteLeaseIds`. See STYLE_GUIDE §18.',
			);
		}

		// Acquisition ordering: dispatch lock must be acquired before
		// bootstrap lock so finalizers release in the safe order
		// (bootstrap first, dispatch second).
		const dispatchAcquireIdx = unifiedBody.indexOf('acquireStackLock(profile.dispatchLockFile,');
		const bootstrapAcquireIdx = unifiedBody.indexOf('acquireStackLock(profile.bootstrapLockFile,');
		const bootstrapCallIdx = unifiedBody.indexOf('bootstrap({');
		expect(dispatchAcquireIdx).toBeGreaterThan(-1);
		expect(bootstrapAcquireIdx).toBeGreaterThan(dispatchAcquireIdx);
		expect(bootstrapCallIdx).toBeGreaterThan(bootstrapAcquireIdx);
	});

	it('boot() does NOT have a scoped block that closes between the dispatch scan and bootstrap()', () => {
		const source = stripComments(readFileSync(ROUTER_SERVICE_PATH, 'utf8'));
		const bootStart = source.indexOf('const boot:');
		expect(bootStart).toBeGreaterThan(-1);
		const contributeStart = source.indexOf('const contributeRoute', bootStart);
		const bootSlice = source.slice(bootStart, contributeStart);

		// Forbidden shape: an Effect.scoped block inside boot that
		// contains `readDispatchRouteScan(` (the protected-id source) or
		// `sweepStaleDispatchRoutes(` but NOT `bootstrap({` — the lock
		// would close before bootstrap consumes the stale ids.
		for (const match of bootSlice.matchAll(/Effect\.scoped\s*\(/g)) {
			const openIdx = (match.index ?? 0) + match[0].length - 1;
			const closeIdx = findBalancedClose(bootSlice, openIdx);
			if (closeIdx <= openIdx) continue;
			const body = bootSlice.slice(openIdx + 1, closeIdx);
			const reads =
				body.includes('readDispatchRouteScan(') || body.includes('sweepStaleDispatchRoutes(');
			if (reads && !body.includes('bootstrap({')) {
				throw new Error(
					'Found an Effect.scoped block inside `boot()` that reads dispatch routes ' +
						'(readDispatchRouteScan / sweepStaleDispatchRoutes) but does NOT call ' +
						'`bootstrap({ ... })` — the dispatch lock would close before bootstrap ' +
						'consumes `protectedRouteLeaseIds`, opening a peer-write race. ' +
						'See STYLE_GUIDE §18.',
				);
			}
		}
	});
});

// ---------------------------------------------------------------------------
// BEHAVIORAL cover — drive the real contributeRoute lock-across-probe path.
// ---------------------------------------------------------------------------
//
// Seam parked: the route-readiness probe `fetch`. `contributeRoute` calls
// it from inside the SAME `Effect.scoped` block that acquired the dispatch
// lock (service.ts ~933-957). Parking that fetch on a Deferred suspends a
// fiber PROVABLY inside the scoped lock block, after `publishRouteFile`
// wrote the dispatch file, while `waitForPublicRouteReadiness` runs. The
// lock here is the REAL `acquireStackLock` — an O_EXCL file on disk at
// `profile.dispatchLockFile`. So "is the lock held across the probe?"
// reduces to a directly observable filesystem fact: does the lock file
// exist while the probe is parked?
//
// Falsifiability against backlog #10a: if a refactor releases the lock
// before the probe (splitting the scope, or hoisting
// waitForPublicRouteReadiness out of the scoped block), the scope
// finalizer unlinks `dispatchLockFile` BEFORE the probe parks — so the
// `existsSync(dispatchLockFile)` assertion fails, AND the forked second
// contributor would no longer be blocked. Both assertions flip red on the
// regression the grep above only catches by source spelling.

const allocatedTmpDirs: Array<string> = [];
afterAll(() => {
	for (const dir of allocatedTmpDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

const makeTmpDir = (): string => {
	const dir = mkdtempSync(join(tmpdir(), 'devstack-router-lock-behavior-'));
	allocatedTmpDirs.push(dir);
	return dir;
};

const behaviorIdentity = {
	app: appName('my-app'),
	stack: stackName('main'),
	network: 'localnet',
};

const behaviorUpstreams = Layer.succeed(UpstreamResolverService)({
	resolveContainer: (target) => Effect.succeed({ host: '172.20.0.5', port: target.containerPort }),
	resolveHostLoopback: (target) => Effect.succeed({ host: '127.0.0.1', port: target.port }),
});

const behaviorRegistry = layerEntrypointRegistry([
	{ name: 'wallet-app', port: 6173, protocol: 'http' },
]);

const makeBehaviorProfile = (dispatchDir: string): RouterProfile => ({
	version: 1,
	id: 'lock-behavior-profile',
	userId: 'test-user',
	dockerContextId: 'test-docker',
	stateDir: join(dispatchDir, '..'),
	dispatchDir,
	containerName: 'devstack-router-lock-behavior',
	networkName: 'devstack-router-lock-behavior',
	bootstrapLockFile: join(dispatchDir, 'locks', 'bootstrap.lock'),
	dispatchLockFile: join(dispatchDir, 'locks', 'dispatch.lock'),
});

const makeBehaviorLayer = (profile: RouterProfile, fetch: HttpProbeFetch) =>
	layerRouterService.pipe(
		Layer.provideMerge(
			Layer.mergeAll(
				layerIdentity(behaviorIdentity),
				behaviorRegistry,
				layerTraefikContainerOpsStub,
				behaviorUpstreams,
				NodeFileSystem.layer,
				layerRouterConfigLiteral({
					disabled: false,
					profile,
					image: 'traefik:v3.5',
					// Generous timeout so the parked probe never times out while
					// we make assertions; the probe returns ready immediately
					// once we release it.
					routeReadinessProbe: {
						enabled: true,
						timeoutMs: 30_000,
						intervalMs: 5,
						requestTimeoutMs: 30_000,
						fetch,
					},
				}),
			),
		),
	);

// Two distinct routes: distinct `role` → distinct hostname (so they do
// NOT collide on the same entrypoint port) AND distinct serviceKey →
// distinct dispatchFileId (so they write different dispatch files). They
// share the SAME per-profile dispatch lock file, which is the resource
// whose hold-across-probe we are proving. `aggregatorDispatch` is the
// SECOND contributor; it must block on the lock A holds.
const walletApiDispatch = { serviceKey: 'wallet.my-app.main', role: 'api' };
const aggregatorDispatch = { serviceKey: 'walrus.my-app.main', role: 'aggregator' };

describe('router contributeRoute holds the real dispatch lock across the readiness probe (behavioral)', () => {
	// `it.live`: the production `acquireStackLock` backoff sleeps under
	// `underLiveClock` and the probe `fetch` is a real Promise, so this
	// path needs the wall clock. The Deferred park keeps it deterministic
	// (no spin, no timing flake) — the same property boot-concurrency.test.ts
	// relies on. (The finding suggested it.effect+TestClock; the parked
	// real-Promise + live-clock lock makes it.live the precise fit, mirroring
	// every sibling readiness-probe test in service.test.ts.)
	it.live(
		'lock file is present on disk while the probe is parked, and a concurrent contributor is blocked until release',
		() =>
			Effect.gen(function* () {
				const dir = makeTmpDir();
				const profile = makeBehaviorProfile(dir);

				// Parked probe: signal `aEntered` on fiber A's first probe call
				// (A is now inside the scoped lock block, mid-probe), then await
				// `release`. Once released it reports the route ready so A
				// completes cleanly. Fiber B's route uses a different
				// dispatchFileId; if B ever reaches its own probe it sets
				// `bEntered` — which must NOT happen while A holds the lock.
				const aEntered = yield* Deferred.make<void>();
				const release = yield* Deferred.make<void>();
				const bEntered = yield* Deferred.make<void>();

				// Post-publish handshakes. Each contributor signals `published`
				// once `contributeRoute` has returned (its dispatch lock has
				// already been released by the service-internal scope, and its
				// route is now in `applied`), then PARKS on `holdOpen` so its
				// OUTER test-wrapper scope stays open. Keeping the wrapper scope
				// open is what defers the contributeRoute scope-finalizer that
				// removes the route from `applied` — so the test can observe both
				// routes applied simultaneously before tearing the scopes down.
				const aPublished = yield* Deferred.make<void>();
				const bPublished = yield* Deferred.make<void>();
				const holdOpen = yield* Deferred.make<void>();

				const readyHeaderRef = { a: '', b: '' };
				const fetch: HttpProbeFetch = (_input, init) =>
					Effect.runPromise(
						Effect.gen(function* () {
							const host = new Headers(init?.headers).get('host');
							const isA = host === 'api.my-app.localhost';
							if (isA) {
								yield* Deferred.succeed(aEntered, undefined);
								yield* Deferred.await(release);
								return new Response('ready', {
									status: 200,
									headers: { [ROUTE_READINESS_HEADER]: readyHeaderRef.a },
								});
							}
							// Fiber B's probe — should only ever run AFTER A released
							// the lock. Mark that it started so the test can assert it
							// did NOT start while A was parked.
							yield* Deferred.succeed(bEntered, undefined);
							return new Response('ready', {
								status: 200,
								headers: { [ROUTE_READINESS_HEADER]: readyHeaderRef.b },
							});
						}),
					);

				yield* Effect.scoped(
					Effect.gen(function* () {
						const router = yield* RouterService;
						yield* router.boot();
						readyHeaderRef.a = yield* dispatchFileId({
							identity: behaviorIdentity,
							dispatch: walletApiDispatch,
						});
						readyHeaderRef.b = yield* dispatchFileId({
							identity: behaviorIdentity,
							dispatch: aggregatorDispatch,
						});

						// Fiber A: contributes the wallet route, parks inside the
						// scoped lock block mid-probe (holding the dispatch lock).
						// After contributeRoute returns it signals `aPublished` and
						// parks on `holdOpen` — its wrapper scope stays open so the
						// route remains in `applied`.
						const fiberA = yield* Effect.forkChild(
							Effect.scoped(
								Effect.gen(function* () {
									const endpoint = yield* router.contributeRoute({
										kind: 'routable',
										endpointName: 'wallet-app',
										dispatchId: walletApiDispatch,
										upstream: { type: 'host-loopback', port: 6173 },
										cors: true,
										wireProtocol: 'http',
									});
									yield* Deferred.succeed(aPublished, undefined);
									yield* Deferred.await(holdOpen);
									return endpoint;
								}),
							),
						);

						// Wait until A is provably parked inside its readiness probe
						// — i.e. inside the scoped lock block, after the dispatch
						// file write.
						yield* Deferred.await(aEntered);

						// (1) The dispatch file A owns is on disk (publishRouteFile
						// ran before the probe).
						expect(readdirSync(dir)).toContain(dispatchFilename(readyHeaderRef.a));

						// (2) THE INVARIANT: the real O_EXCL dispatch lock file is
						// present on disk while the probe is parked. This is only
						// true if `acquireStackLock`'s scope has NOT yet closed —
						// i.e. the lock is genuinely held ACROSS the probe. A
						// refactor that released the lock before the probe makes
						// this file absent and fails the test.
						expect(existsSync(profile.dispatchLockFile)).toBe(true);

						// Fiber B: a SECOND contributor for a different route. It
						// must block contending for the SAME dispatch lock (one lock
						// file per profile) that A holds. We give it room to run; it
						// cannot reach its own probe while A holds the lock, so
						// `bEntered` stays unfulfilled.
						const fiberB = yield* Effect.forkChild(
							Effect.scoped(
								Effect.gen(function* () {
									const endpoint = yield* router.contributeRoute({
										kind: 'routable',
										endpointName: 'wallet-app',
										dispatchId: aggregatorDispatch,
										upstream: { type: 'host-loopback', port: 6173 },
										cors: true,
										wireProtocol: 'http',
									});
									yield* Deferred.succeed(bPublished, undefined);
									yield* Deferred.await(holdOpen);
									return endpoint;
								}),
							),
						);
						yield* Effect.sleep('100 millis');

						// (3) B has NOT reached its probe — it is blocked on the lock
						// A holds. (If A released the lock before its probe, B would
						// have acquired it and reached `bEntered` by now.)
						const bReachedProbe = yield* Deferred.isDone(bEntered);
						expect(bReachedProbe).toBe(false);

						// (3b) And B has NOT published its route yet — it is still
						// blocked on the lock, so `applied` holds at most A's route.
						expect(yield* Deferred.isDone(bPublished)).toBe(false);

						// Release A's probe. A finishes its probe, publishes to
						// `applied`, and its SERVICE-INTERNAL scope closes → dispatch
						// lock released → B wins the lock and runs to completion. A
						// then signals `aPublished` and parks (wrapper scope open).
						yield* Deferred.succeed(release, undefined);

						// Both contributors have now returned from contributeRoute
						// (A after release, B after winning the freed lock) and are
						// parked on `holdOpen`, so BOTH wrapper scopes are still open
						// and BOTH routes are live in `applied`.
						yield* Deferred.await(aPublished);
						yield* Deferred.await(bPublished);

						// B did reach its probe once the lock freed up.
						expect(yield* Deferred.isDone(bEntered)).toBe(true);

						// Both routes are applied simultaneously (observed while both
						// wrapper scopes are still open).
						const applied = yield* SubscriptionRef.get(router.applied);
						expect(applied).toHaveLength(2);

						// While both contributors are parked-open the lock has been
						// released by both service-internal scopes — the hold-across-
						// probe window is the probe window only, not the lifetime of
						// the route.
						expect(existsSync(profile.dispatchLockFile)).toBe(false);

						// Release both contributors → wrapper scopes close →
						// scope-finalizers drop both routes from `applied` and unlink
						// the dispatch files.
						yield* Deferred.succeed(holdOpen, undefined);

						const endpointA = yield* Fiber.join(fiberA);
						const endpointB = yield* Fiber.join(fiberB);
						// `contributeRoute` returns the `ResolvedRoute`; the public http
						// URL is `http://<hostname>:<entrypointPort>`.
						expect(`http://${endpointA.hostname}:${endpointA.entrypointPort}`).toBe(
							'http://api.my-app.localhost:6173',
						);
						expect(`http://${endpointB.hostname}:${endpointB.entrypointPort}`).toBe(
							'http://aggregator.my-app.localhost:6173',
						);

						// Both wrapper scopes closed → finalizers drained `applied`.
						const afterRelease = yield* SubscriptionRef.get(router.applied);
						expect(afterRelease).toHaveLength(0);

						// And the dispatch lock file is gone — every scoped lock
						// block closed, finalizers unlinked it.
						expect(existsSync(profile.dispatchLockFile)).toBe(false);
					}).pipe(Effect.provide(makeBehaviorLayer(profile, fetch))),
				);
			}),
	);
});
