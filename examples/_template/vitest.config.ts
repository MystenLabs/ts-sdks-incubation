import { defineConfig } from 'vitest/config';

// Plain vitest config. No mega-helper — per
// `@mysten-incubation/devstack`'s design, vitest config stays
// user-owned. For chain-mode integration tests, bind the devstack to
// `@effect/vitest`'s `it.layer` via `withDevstack`:
//
//   import { devstack, Sui } from '@mysten-incubation/devstack';
//   import { withDevstack } from '@mysten-incubation/devstack/vitest';
//   const stack = devstack(Sui());
//   withDevstack(stack)('suite', (it) => {
//     it.effect('reads sui', () => Effect.gen(function* () { /* ... */ }));
//   });
export default defineConfig({
	test: {
		include: ['src/**/*.{test,spec}.ts?(x)'],
		exclude: ['e2e/**', 'node_modules', 'dist', '.turbo'],
		passWithNoTests: true,
	},
});
