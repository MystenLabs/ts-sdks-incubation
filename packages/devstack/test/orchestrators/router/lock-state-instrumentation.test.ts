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
