import { defineConfig } from 'vitest/config';

// Plain vitest config. No mega-helper — per
// `@mysten-incubation/devstack`'s design, vitest config stays
// user-owned. For chain-mode integration tests, bind the devstack to
// `@effect/vitest`'s `it.effect` via `withDevstack`:
//
//   import { Account, devstack } from '@mysten-incubation/devstack';
//   import { withDevstack } from '@mysten-incubation/devstack/vitest';
//   const alice = Account('alice');
//   const stack = devstack(alice);
//   withDevstack(stack)('suite', (it) => {
//     it.effect('alice is funded', () =>
//       Effect.gen(function* () {
//         const a = yield* alice;
//         expect(a.address).toMatch(/^0x/);
//       }),
//     );
//   });
export default defineConfig({
	test: {
		include: ['src/**/*.{test,spec}.ts?(x)'],
		exclude: ['e2e/**', 'node_modules', 'dist', '.turbo'],
		passWithNoTests: true,
	},
});
