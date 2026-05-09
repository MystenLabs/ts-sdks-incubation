import { defineConfig } from 'vitest/config';

// Integration suite. Boots real sui / walrus / seal containers, so
// runs ~minutes per test (vs. ~seconds for the unit suite). Gated
// behind a separate config + `pnpm test:integration` script so the
// default `pnpm test` stays fast and CI-cheap.
//
// Tests under `src/integration/**` use the `itIntegration` /
// `describeIntegration` helpers (see `src/integration/_helpers.ts`)
// which gate on docker availability. Test files that additionally
// need a non-trivial image build (walrus's cargo compile) check
// `process.env.RUN_SLOW_INTEGRATION` so the default
// `pnpm test:integration` invocation stays runnable in a few
// minutes; opt into the slow suite via
// `RUN_SLOW_INTEGRATION=1 pnpm test:integration`.
export default defineConfig({
	test: {
		include: ['src/integration/**/*.test.ts'],
		// 10 minutes per test — gives sui-localnet's first cold
		// boot + walrus deploy room without spurious timeouts.
		testTimeout: 10 * 60_000,
		hookTimeout: 60_000,
		// Run integration tests serially. Two stacks racing on
		// docker resources (image pulls, network creates) tend to
		// thrash the daemon and produce flakes; one-at-a-time keeps
		// failure modes diagnosable.
		fileParallelism: false,
	},
});
