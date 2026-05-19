// Vitest fixtures for devstack. Thin wrapper that hands the
// composed devstack layer to @effect/vitest's `it.layer(...)`, so tests
// can `yield*` whichever primitive tags the devstack provides without
// re-deriving a Layer each time.
//
//   import { devstack, Sui } from '@mysten-incubation/devstack';
//   import { withDevstack } from '@mysten-incubation/devstack/vitest';
//
//   const stack = devstack(Sui());
//
//   withDevstack(stack)('my suite', (it) => {
//     it.effect('reads sui', () => Effect.gen(function* () {
//       const s = yield* SuiTag;
//       // ...
//     }));
//   });
//
// Notes:
//   - There is no `setup` / `teardown` surface here. Acquire/release
//     is owned by `it.layer` (via `withDevstack`). Out-of-band bring-up
//     for non-Effect harnesses is covered by `setupDevstack` in
//     `../playwright/setup-devstack.ts` (Playwright
//     globalSetup/globalTeardown — works for any acquire/release
//     boundary that lives outside an `it.effect` body).
//   - Per-node acquire status is intentionally not exposed outside the
//     engine. If a primitive needs to publish state, it does so via
//     its tag's shape or via `StateStore` (internal).

/* eslint-disable @typescript-eslint/no-explicit-any */

import type { Layer } from 'effect';
import { it as effectIt } from '@effect/vitest';
import type { DevstackHandle } from '../engine/supervisor.js';

export { defineDevstackVitestConfig, type DevstackVitestConfigOptions } from './define-config.js';

// Bind a devstack to `@effect/vitest`'s `it.layer(...)`. Returns the
// curried `(name?, body)` describe-binder so tests in the body can
// `yield*` services from the stack directly. The handle's layer
// carries `R = any` by design (see `engine/supervisor.ts`) — we cast to
// the `never` requirement that `it.layer` expects; any unmet service
// surfaces at runtime via Effect's ServiceNotFound, same as `run()`.
export const withDevstack = (handle: DevstackHandle) =>
	effectIt.layer(handle.layer as Layer.Layer<any, any, never>);
