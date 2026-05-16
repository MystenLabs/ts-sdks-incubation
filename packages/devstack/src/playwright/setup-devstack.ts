// Playwright integration for devstack. Playwright drives the
// stack from `playwright.config.ts` via `globalSetup` / `globalTeardown`
// hooks — module-level functions that return a Promise. Effect's natural
// shape (`Layer.launch` running forever until interrupted) doesn't fit:
// we need acquire-then-return for setup and a separate teardown hook.
//
// The mechanic: create a long-lived Scope, build the devstack layer
// against that scope (which registers each primitive's finalizer onto
// it), then in teardown close the scope so finalizers run.
//
//   // playwright.config.ts
//   import { setupDevstack } from '@mysten-incubation/devstack/playwright';
//   import devstack from './devstack.config.ts';
//   const fixture = setupDevstack(devstack);
//   export default {
//     globalSetup: fixture.globalSetup,
//     globalTeardown: fixture.globalTeardown,
//     // ...
//   };
//
// Playwright invokes globalSetup once before any test runs and
// globalTeardown once after all tests, both in the main config process —
// so a shared module-level scope is the right granularity. Worker-scoped
// bring-up isn't supported here; if a suite needs per-worker stacks, run
// playwright with multiple config files or build a custom worker fixture
// on top of `withDevstack`'s primitives.

/* eslint-disable @typescript-eslint/no-explicit-any */

import { Effect, Exit, Scope } from 'effect';
import { buildWithScope } from 'effect/Layer';
import type { DevstackHandle } from '../engine/supervisor.js';

export interface DevstackPlaywrightFixture {
	/** Wire into `playwright.config.ts` `globalSetup`. Returns once every
	 * stack primitive has acquired (i.e., the layer build effect
	 * completes); the underlying resources stay alive on a long-lived
	 * scope held by this fixture instance. */
	readonly globalSetup: () => Promise<void>;
	/** Wire into `playwright.config.ts` `globalTeardown`. Closes the
	 * scope, running all primitive finalizers in reverse order. */
	readonly globalTeardown: () => Promise<void>;
}

export const setupDevstack = (handle: DevstackHandle): DevstackPlaywrightFixture => {
	let scope: Scope.Closeable | undefined;

	return {
		globalSetup: async () => {
			if (scope !== undefined) {
				throw new Error('[devstack/playwright] globalSetup called twice');
			}
			// Make a sequential-finalizer scope and build the devstack
			// layer into it. `buildWithScope` returns the Context — we
			// don't need it here (tests run in separate Playwright
			// worker processes; in-process services aren't reachable
			// across that boundary anyway), but we must `runPromise` the
			// effect to actually execute acquires.
			const made = Scope.makeUnsafe('sequential');
			// The devstack layer's `R` channel is intentionally `any`
			// (see `define-devstack.ts`) — the platform / infra layers it
			// composes in fully discharge requirements at runtime even
			// when the static type doesn't reflect that. Cast to `never`
			// at the runPromise boundary; missing services surface as
			// ServiceNotFound at runtime, same as the production `run()`.
			const build = buildWithScope(handle.layer, made) as Effect.Effect<any, any, never>;
			try {
				await Effect.runPromise(build);
			} catch (err) {
				// Acquisition failed partway — close any finalizers that
				// did register before re-raising, so the failure doesn't
				// leak half-started subprocesses.
				await Effect.runPromise(Scope.close(made, Exit.void)).catch(() => undefined);
				throw err;
			}
			scope = made;
		},

		globalTeardown: async () => {
			const made = scope;
			scope = undefined;
			if (made === undefined) return;
			await Effect.runPromise(Scope.close(made, Exit.void));
		},
	};
};
