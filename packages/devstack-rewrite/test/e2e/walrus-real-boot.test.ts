// End-to-end boot of `examples/walrus-mini-rewrite/` with the REAL
// vendored walrus image (downloads the walrus release tarball at
// build time — see `packages/devstack-rewrite/images/walrus/Dockerfile`).
//
// This is the load-bearing real-walrus e2e test. The stub variant
// (`walrus-stub-boot.test.ts`) exercises the plugin's plumbing without
// the upstream binary; this one exercises the real-image boot path:
//
//   1. Build the walrus image from the vendored Dockerfile.
//   2. Boot sui + admin account + walrus(local).
//   3. Assert all three plugin keys reach `ready`.
//   4. Assert the ready set. Blob write/read is covered by a future
//      private-content roundtrip driver, not by this boot test.
//
// WALL-CLOCK BUDGET: cold-cache build takes ~60-90s (curl + tar of
// two release tarballs + git clone of the walrus contracts subdir).
// Warm builds are ~5s (docker layer cache). Genesis deploy + node
// startup adds another ~60s. Test cap: 6 minutes.
//
// RUN: this file lives under `test/e2e/**` so it is excluded from the
// default `pnpm test` run. Invoke via `pnpm test:e2e` (which sets
// `DEVSTACK_RUN_E2E=1`) or the dedicated e2e CI job.

import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { runBoot } from './boot-config-impl.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = resolve(
	HERE,
	'..',
	'..',
	'..',
	'..',
	'examples',
	'walrus-mini-rewrite',
	'devstack.config.ts',
);

/** Skip the test when docker isn't reachable. Returns a one-line
 *  reason string for the test's `expect(reachable, reason).toBe(true)`. */
const dockerReachable = (): { ok: boolean; detail: string } => {
	const res = spawnSync('docker', ['info', '--format', '{{.ServerVersion}}'], {
		encoding: 'utf8',
		timeout: 5_000,
	});
	if (res.status !== 0) {
		return { ok: false, detail: `docker info failed: status=${res.status}: ${res.stderr}` };
	}
	return { ok: true, detail: res.stdout.trim() };
};

describe('walrus real-binary boots end-to-end', () => {
	it(
		'walrus + sui + admin reach `ready` against the real vendored image',
		async () => {
			const docker = dockerReachable();
			if (!docker.ok) {
				// Soft-skip on machines without docker; the `test/e2e/**`
				// gate already filters this out from `pnpm test`, but a
				// clear log helps when the test is invoked directly.
				console.warn(`walrus-real-boot: skipping — ${docker.detail}`);
				return;
			}

			// No `WALRUS_CARGO_IMAGE_OVERRIDE` — force the real
			// vendored Dockerfile build path.
			delete process.env.WALRUS_CARGO_IMAGE_OVERRIDE;

			const result = await runBoot({
				configPath: CONFIG_PATH,
				appName: 'walrus-mini',
				stackName: 'main',
			});

			// Three-plugin expectation. Ordinals match the variadic
			// position in `examples/walrus-mini-rewrite/devstack.config.ts`:
			// sui(0), admin(1), walrus(2).
			const expectedKeys = ['sui#0', 'account/admin#1', 'walrus#2'];
			expect(result.failures).toEqual([]);
			expect(result.topLevelErrorCount).toBe(0);
			expect([...result.readyKeys].sort()).toEqual([...expectedKeys].sort());
		},
		6 * 60_000,
	);
});
