// Router dispatch-lock-across-probe regression cover (backlog #10a).
//
// The production fix in `src/orchestrators/router/service.ts` wraps
// `publishRouteFile + waitForPublicRouteReadiness` inside the same
// `Effect.scoped` block that calls `acquireStackLock`. Effect's Scope
// semantics guarantee the lock finalizer (unlinkSync) fires only when
// the scoped block closes — which is AFTER both operations complete.
//
// The original `concurrent-contribute-route.test.ts` exercised this
// invariant by racing real fibers under `it.live + Promise gates +
// Effect.forkScoped` — that harness starved sibling vitest workers
// under parallel scheduling and was deleted (Phase 2 #10 closing
// notes). A behavior-mocking test would either need vi.mock of the
// substrate lock module (brittle and module-load-order sensitive) or a
// `StackLockService` refactor (architecturally desirable but out of
// scope for a regression cover).
//
// This file pins the invariant STRUCTURALLY: the source-level shape
// "acquireStackLock + publishRouteFile + waitForPublicRouteReadiness
// inside a single Effect.scoped block" IS what makes Effect.Scope
// semantics carry the lock across the probe. A future refactor that
// breaks this shape — releasing the lock before the probe, splitting
// scopes, or hoisting the probe outside the scoped block — fails this
// test before it can hit production.
//
// See STYLE_GUIDE §18 cross-process protocol for the codified rule.

import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

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
			const reads = body.includes('readDispatchRouteScan(') || body.includes('sweepStaleDispatchRoutes(');
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
