// End-to-end boot of `examples/_template-rewrite/` against the real
// docker runtime.
//
// Promoted from `scratch/boot-template.ts` — same wiring (substrate
// Layers + ContainerRuntime + the migrated template config), but
// asserted via vitest so the canonical proof of "the rewrite actually
// boots" lives in CI rather than a one-shot script.
//
// What this test pins:
//   - The substrate Layer stack composes without missing dependencies.
//   - Each plugin in the `_template-rewrite` stack reaches `ready`
//     within the per-test timeout. Concrete plugins: `sui#0`,
//     `account/alice#1`, `account/bob#2`, `package:hello#3` — four
//     of four expected by the current ported config.
//   - The per-plugin Scope unwinds cleanly at the test's end (the
//     boot driver invokes `Effect.scoped(...)`, so finalizer errors
//     would surface as a top-level error count).
//   - Quiesce: after every plugin reaches ready, no new top-level
//     errors accumulate over a short wall-clock window. The boot
//     driver's projection snapshot is read once post-quiesce so an
//     unstable post-ready stack (e.g. a container that flaps back to
//     starting) would surface as a non-zero error count.
//   - Leak: post-scope-close, no RUNNING docker container carries
//     the test's identity labels. Asserts the supervisor's
//     scope-bound finalizers actually stopped every container they
//     spawned. Exited containers are permitted — the substrate's
//     policy is "scope finalizer stops, next-boot `sweepOrphans`
//     reaps".
//
// Prerequisites: docker must be reachable on the host. The substrate's
// `ContainerRuntime` calls `docker info` indirectly when standing up
// the sui container; without docker the boot fails.

import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Effect } from 'effect';
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
	'_template-rewrite',
	'devstack.config.ts',
);

const APP_NAME = 'template';
const STACK_NAME = 'main';

/** Skip the test when docker isn't reachable. Returns a one-line
 *  reason string for the test's warn-and-return branch. */
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

/** Count RUNNING docker containers carrying the substrate's identity
 *  labels (app + stack). Post-scope-close, every container the
 *  supervisor started must have transitioned out of `running`
 *  (the substrate's container scope finalizer stops, but does NOT
 *  remove — the boot-time `sweepOrphans` reaps exited containers from
 *  a prior process on the NEXT boot). A running container with these
 *  labels after the scope unwound is the actual leak. */
const countRunningLabeledContainers = (app: string, stack: string): number => {
	const res = spawnSync(
		'docker',
		[
			'ps',
			'--filter',
			`label=devstack.app=${app}`,
			'--filter',
			`label=devstack.stack=${stack}`,
			'--filter',
			'status=running',
			'--format',
			'{{.ID}}',
		],
		{ encoding: 'utf8', timeout: 5_000 },
	);
	if (res.status !== 0) return -1;
	const lines = res.stdout.split('\n').filter((l) => l.trim().length > 0);
	return lines.length;
};

describe('_template-rewrite boots end-to-end', () => {
	// 180s — the cold-image-build path for sui's container can take
	// 60-80s on a fresh runtime root, plus the substrate boot
	// overhead. Subsequent runs hit the docker layer cache and finish
	// in <20s.
	it('every plugin reaches `ready` against real docker', async () => {
		const docker = dockerReachable();
		if (!docker.ok) {
			console.warn(`template-boot: skipping — ${docker.detail}`);
			return;
		}

		// Quiesce window. After every plugin reaches ready, hold the
		// scope open for two short cycles so a flapping container
		// would have time to surface an error before the snapshot
		// read. 2 × 1.5s is a deliberate balance: long enough to
		// catch a fast restart loop, short enough not to bloat the
		// e2e budget.
		const quiesceMs = 3_000;

		const result = await runBoot({
			configPath: CONFIG_PATH,
			appName: APP_NAME,
			stackName: STACK_NAME,
			withinScope: () => Effect.sleep(`${quiesceMs} millis`),
		});

		// Four-plugin expectation — `_template-rewrite` composes sui +
		// alice + bob + hello. If the config grows a member, update
		// this list deliberately.
		const expectedKeys = ['sui#0', 'account/alice#1', 'account/bob#2', 'package:hello#3'];
		expect(result.failures).toEqual([]);
		expect(result.topLevelErrorCount).toBe(0);
		expect([...result.readyKeys].sort()).toEqual([...expectedKeys].sort());

		// Leak assertion: the boot scope has unwound by the time
		// `runBoot` returns. No RUNNING container should still carry
		// this test's identity labels (the substrate's policy keeps
		// exited containers around until the next boot's
		// `sweepOrphans`; the leak we test for is a still-running
		// container that escaped its scope finalizer). -1 means the
		// docker query itself failed; fail loudly in that case
		// rather than treating it as a leak.
		const leaked = countRunningLabeledContainers(APP_NAME, STACK_NAME);
		expect(leaked, `docker ps query failed`).not.toBe(-1);
		expect(leaked, `running containers leaked for ${APP_NAME}/${STACK_NAME}`).toBe(0);
	}, 180_000);
});
