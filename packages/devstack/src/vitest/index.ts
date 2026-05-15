// Vitest fixtures for devstack. Thin wrapper that hands the
// composed devstack layer to @effect/vitest's `it.layer(...)`, so tests
// can `yield*` whichever primitive tags the devstack provides without
// re-deriving a Layer each time.
//
//   import { defineDevstack, suiLocalnet } from '@mysten-incubation/devstack';
//   import { withDevstack } from '@mysten-incubation/devstack/vitest';
//
//   const devstack = defineDevstack([suiLocalnet()]);
//
//   withDevstack(devstack)('my suite', (it) => {
//     it.effect('reads sui', () => Effect.gen(function* () {
//       const s = yield* Sui;
//       // ...
//     }));
//   });
//
// Divergences from v3's harness:
//   - No `setup` / `teardown`. v3 exposed those for `vitest globalSetup`
//     bring-up; v4's Effect-native model puts the layer behind
//     `it.layer` (via `withDevstack`), and out-of-band bring-up is
//     covered by `setupDevstack` in `../playwright/setup-devstack.ts`
//     (Playwright globalSetup/globalTeardown — works for any
//     out-of-test acquire/release boundary).
//   - No `getNodeState`. v4 layers don't expose per-node acquire status
//     outside the engine; if a primitive needs to publish state, it
//     does so via its tag's shape or via `StateStore` (internal).

/* eslint-disable @typescript-eslint/no-explicit-any */

import type { Layer } from 'effect';
import { it as effectIt } from '@effect/vitest';
import type { Devstack } from '../define-devstack.js';

// Bind a devstack to `@effect/vitest`'s `it.layer(...)`. Returns the
// curried `(name?, body)` describe-binder so tests in the body can
// `yield*` services from the stack directly. The devstack's layer
// carries `R = any` by design (see `define-devstack.ts`) — we cast to
// the `never` requirement that `it.layer` expects; any unmet service
// surfaces at runtime via Effect's ServiceNotFound, same as `run()`.
export const withDevstack = (devstack: Devstack) =>
	effectIt.layer(devstack.layer as Layer.Layer<any, any, never>);
