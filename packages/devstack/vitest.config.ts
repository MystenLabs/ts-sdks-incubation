import { defineConfig } from 'vitest/config';

// E2E tests (`test/e2e/**`) boot the full substrate against the real
// docker runtime — they share docker port 9000 for the per-stack
// Traefik router and other host-bound ports, so running them in
// parallel deadlocks on bind-collisions. They also pay 60-300s of
// wall-clock per file (container pulls, genesis, image builds).
//
// Default `pnpm test` runs the in-process suite ONLY. Opt into e2e
// with `pnpm test:e2e` (sets `DEVSTACK_RUN_E2E=1`); the e2e leg pins
// `fileParallelism: false` so test FILES run sequentially in a single
// fork — docker port leases stay serial across files. (Vitest 4
// dropped `poolOptions.forks.singleFork`; the modern surface is the
// top-level `fileParallelism` knob.)
const runE2E = process.env.DEVSTACK_RUN_E2E === '1';

export default defineConfig({
	test: {
		exclude: ['**/node_modules/**', '**/dist/**', ...(runE2E ? [] : ['test/e2e/**'])],
		...(runE2E
			? {
					include: ['test/e2e/**/*.test.ts'],
					pool: 'forks' as const,
					fileParallelism: false,
					testTimeout: 300_000,
					hookTimeout: 300_000,
				}
			: {}),
	},
});
