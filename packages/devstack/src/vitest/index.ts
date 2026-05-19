// Vitest integration for devstack — single public surface for the
// `@mysten-incubation/devstack/vitest` subpath.
//
// Today this subpath ships exactly one helper: `defineDevstackVitestConfig`
// for `vitest.config.ts`. The historical `withDevstack(handle)` shim
// (a thin wrapper around `@effect/vitest`'s `it.layer(handle.layer)`)
// was deleted in Wave 6 — zero in-tree callers, and the underlying
// pattern is one line at the consumer:
//
//   import { it } from '@effect/vitest';
//   const stack = devstack(Sui());
//   it.layer(stack.layer)('my suite', (it) => {
//     it.effect('reads sui', () => Effect.gen(function* () {
//       const s = yield* SuiTag;
//       // ...
//     }));
//   });
//
// Out-of-band bring-up for non-Effect harnesses lives in
// `../playwright/setup-devstack.ts` (Playwright globalSetup/globalTeardown).

export { defineDevstackVitestConfig, type DevstackVitestConfigOptions } from './define-config.js';
