import { defineConfig } from 'vitest/config';

// Plain vitest config. No mega-helper — per
// `@mysten-incubation/devstack-effect`'s design, vitest config stays
// user-owned. For chain-mode integration tests, bind the devstack to
// `@effect/vitest`'s `it.layer` via `withDevstack`:
//
//   import { defineDevstack, suiLocalnet } from '@mysten-incubation/devstack-effect';
//   import { withDevstack } from '@mysten-incubation/devstack-effect/vitest';
//   const devstack = defineDevstack([suiLocalnet()]);
//   withDevstack(devstack)('suite', (it) => {
//     it.effect('reads sui', () => Effect.gen(function* () { /* ... */ }));
//   });
export default defineConfig({
	test: {
		include: ['src/**/*.{test,spec}.ts?(x)'],
		exclude: ['e2e/**', 'node_modules', 'dist', '.turbo'],
		passWithNoTests: true,
	},
});
