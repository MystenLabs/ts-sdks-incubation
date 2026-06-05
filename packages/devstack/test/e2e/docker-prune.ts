// Shared docker helpers for the e2e suites — the Docker gate + the
// label-scoped managed-image prune, deduped out of the individual
// `test/e2e/*.test.ts` files (each had copy-pasted these verbatim).

import { spawnSync, type SpawnSyncOptionsWithStringEncoding } from 'node:child_process';

import { dockerCliEnv } from '../../src/runtime/docker/index.ts';

export const dockerSpawnSync = (
	args: ReadonlyArray<string>,
	options: Omit<SpawnSyncOptionsWithStringEncoding, 'encoding' | 'env'> = {},
) =>
	spawnSync('docker', [...args], {
		...options,
		encoding: 'utf8',
		env: {
			...process.env,
			...dockerCliEnv(),
		},
	});

// Docker reachability gate: a missing/unreachable daemon early-returns the
// `it` as a no-op (the `DEVSTACK_RUN_E2E` opt-in is enforced separately by
// vitest.config.ts, so this file-level gate is Docker-only).
export const dockerReachable = (): { ok: boolean; detail: string } => {
	const res = dockerSpawnSync(['info', '--format', '{{.ServerVersion}}'], { timeout: 5_000 });
	if (res.status !== 0) {
		return { ok: false, detail: `docker info failed: status=${res.status}: ${res.stderr}` };
	}
	return { ok: true, detail: res.stdout.trim() };
};

// Label-scoped image prune: removes ONLY the managed `devstack-build:*` /
// `devstack-snapshot:*` images stamped with THIS test's unique app
// (`devstack.app=<app>` + `devstack.managed=true`). The app filter is the
// safety boundary — never tag-prefix, never unfiltered — so it can NEVER touch
// the user's other devstack images. Best-effort: swallow all failures so a
// missing docker or an empty match can't fail the suite. NB: plain
// `docker build -t <tag>` stub images (no devstack labels) are deliberately
// NOT touched — they are not managed devstack-build images.
export const pruneManagedImagesForApp = (app: string): void => {
	try {
		dockerSpawnSync(
			[
				'image',
				'prune',
				'-f',
				'--filter',
				`label=devstack.app=${app}`,
				'--filter',
				'label=devstack.managed=true',
			],
			{ timeout: 60_000 },
		);
	} catch {
		// cleanup must never throw
	}
};

// Label-scoped container cleanup for fixed-name e2e stacks. This removes only
// devstack-managed containers for the given app/stack pair, which keeps reruns
// from inheriting stopped containers left by an interrupted or failed test.
export const removeManagedContainersForAppStack = (app: string, stack: string): void => {
	try {
		const listed = dockerSpawnSync(
			[
				'ps',
				'-aq',
				'--filter',
				`label=devstack.app=${app}`,
				'--filter',
				`label=devstack.stack=${stack}`,
				'--filter',
				'label=devstack.managed=true',
			],
			{ timeout: 30_000 },
		);
		if (listed.status !== 0) return;
		const ids = listed.stdout.split(/\s+/).filter((id) => id !== '');
		if (ids.length === 0) return;
		dockerSpawnSync(['rm', '-f', ...ids], { timeout: 60_000 });
	} catch {
		// cleanup must never throw
	}
};
