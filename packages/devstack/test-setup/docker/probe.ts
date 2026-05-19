// Docker daemon probe — mirrors the skip-if pattern from
// `engine/snapshot.docker.test.ts:59-68`. Probes the daemon at suite-
// load time so tests that depend on real Docker can `describe.skipIf`
// without re-running the probe per test.
//
// `DOCKER_OK` is the eager boolean (resolved at module load). Use it
// like:
//
//   describe.skipIf(!DOCKER_OK)('my docker test', () => {
//     ...
//   });
//
// `requireDocker()` is the runtime check — throws if Docker isn't
// reachable. Use it when a test wants to short-circuit programmatically
// (rare; `describe.skipIf` is preferred so the skip message is visible).

import { spawnSync } from 'node:child_process';

const probeDocker = (): boolean => {
	const out = spawnSync('docker', ['version', '--format', '{{.Server.Version}}'], {
		timeout: 5_000,
		stdio: ['ignore', 'pipe', 'ignore'],
	});
	return out.status === 0 && (out.stdout?.toString() ?? '').trim().length > 0;
};

export const DOCKER_OK: boolean = probeDocker();

export const requireDocker = (): void => {
	if (!DOCKER_OK) {
		throw new Error(
			'Docker daemon not reachable. Start Docker Desktop / dockerd before running this test.',
		);
	}
};

/** Log a one-line notice at suite load when Docker isn't available so
 *  the dev doesn't think the test silently passed. Call once per
 *  describe block at module-load. */
export const stampSkipNoticeIfMissing = (suiteName: string): void => {
	if (!DOCKER_OK) {
		// eslint-disable-next-line no-console
		console.log(
			`[${suiteName}] Docker daemon not reachable — suite skipped. ` +
				'Start Docker Desktop / dockerd to enable.',
		);
	}
};
