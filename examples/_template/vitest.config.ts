import { defineDevstackVitestConfig } from '@mysten-incubation/devstack/vitest';

// For chain-mode integration tests, bind the devstack to
// `@effect/vitest`'s `it.layer` via `withDevstack` (same subpath):
//
//   import { devstack, Sui } from '@mysten-incubation/devstack';
//   import { withDevstack } from '@mysten-incubation/devstack/vitest';
//   const stack = devstack(Sui());
//   withDevstack(stack)('suite', (it) => {
//     it.effect('reads sui', () => Effect.gen(function* () { /* ... */ }));
//   });
export default defineDevstackVitestConfig();
