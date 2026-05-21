// End-to-end boot of `examples/postgres-mini-rewrite/` against the
// real docker runtime. This is the canonical e2e coverage for the
// postgres plugin — every other example that composes postgres
// (deepbook-full, walrus-mini, future fork-graphql) re-uses the same
// service body, so a green run here pins the per-stack network +
// container + database-ensure path.
//
// What this test pins:
//   - The four-member stack (sui + alice + bob + postgres) reaches
//     `ready` against real docker.
//   - The resolved `Postgres` handle carries both declared databases
//     (`app` + `devstack`) and the canonical port (5432).
//   - Both databases are queryable in the live container: a
//     `psql -lqt` invocation through `ContainerRuntime.exec` lists
//     them in postgres's catalog. Catches the failure mode where the
//     handle declares a database that `createdb` never actually
//     materialised. The successful exec is the canonical "daemon is
//     listening + accepting queries" proof — the postgres-mini config
//     opts into neither `hostPort` nor `route: true`, so there is no
//     host-side TCP port to probe.
//
// Prerequisites: docker reachable. Skipped via console warn when not.
//
// Snapshot save + restore is NOT exercised here. `runBoot` now
// provisions SnapshotOrchestratorService for registration-level
// wiring smoke coverage; the remaining gap is a full save -> restore
// roundtrip for the live postgres data path.
// The TCP-probe + database-list assertions cover the "postgres is
// alive and serving" surface; snapshot integrity remains its own e2e.

import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Effect } from 'effect';
import { describe, expect, it } from 'vitest';

import { runBoot } from './boot-config-impl.ts';
import type { Postgres } from '../../src/plugins/postgres/index.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = resolve(
	HERE,
	'..',
	'..',
	'..',
	'..',
	'examples',
	'postgres-mini-rewrite',
	'devstack.config.ts',
);

const dockerReachable = (): { ok: boolean; detail: string } => {
	const res: SpawnSyncReturns<string> = spawnSync(
		'docker',
		['info', '--format', '{{.ServerVersion}}'],
		{ encoding: 'utf8', timeout: 5_000 },
	);
	if (res.status !== 0) {
		return { ok: false, detail: `docker info failed: status=${res.status}: ${res.stderr}` };
	}
	return { ok: true, detail: res.stdout.trim() };
};

describe('postgres-mini-rewrite boots end-to-end', () => {
	it('every plugin reaches `ready` and both databases are queryable', async () => {
		const docker = dockerReachable();
		if (!docker.ok) {
			console.warn(`postgres-mini-boot: skipping — ${docker.detail}`);
			return;
		}

		let pgHandle: Postgres | null = null;
		let dbListStdout: string | null = null;
		let dbListExit: number | null = null;

		const result = await runBoot({
			configPath: CONFIG_PATH,
			appName: 'postgres-mini',
			stackName: 'main',
			withinScope: (ctx) =>
				Effect.gen(function* () {
					const pg = ctx.resolvedValues.get('postgres#3') as Postgres | undefined;
					if (pg === undefined) return;
					pgHandle = pg;

					// `containerRuntime.exec` requires a ContainerHandle; the
					// plugin's resolved value carries `networkAlias` /
					// `name` but not the live `ContainerHandle`. Walk
					// `inspectByLabels` to find the postgres container by
					// label tuple (devstack.app + devstack.stack +
					// devstack.plugin=postgres).
					const inspectExit = yield* ctx.containerRuntime
						.inspectByLabels({
							app: ctx.identity.app,
							stack: ctx.identity.stack,
							plugin: 'postgres',
							role: 'postgres',
						})
						.pipe(Effect.exit);
					if (inspectExit._tag !== 'Success' || inspectExit.value.length === 0) {
						return;
					}
					const handle = inspectExit.value[0]!;

					// `psql -lqt` prints `<db>|<owner>|...` lines, one per
					// database. We grep for the two declared names.
					const execExit = yield* ctx.containerRuntime
						.exec(handle, ['psql', '-U', pg.user, '-lqt'])
						.pipe(Effect.exit);
					if (execExit._tag === 'Success') {
						dbListStdout = execExit.value.stdout;
						dbListExit = execExit.value.exitCode;
					}
				}),
		});

		const expectedKeys = ['sui#0', 'account/alice#1', 'account/bob#2', 'postgres#3'];
		expect(result.failures).toEqual([]);
		expect(result.topLevelErrorCount).toBe(0);
		expect([...result.readyKeys].sort()).toEqual([...expectedKeys].sort());

		// Resolved-handle assertions.
		expect(pgHandle, 'postgres handle should be resolved').not.toBeNull();
		expect([...pgHandle!.databases].sort()).toEqual(['app', 'devstack']);

		// Database list assertions. `psql -lqt` is dash-q (quiet) + -t
		// (tuples only); each row leads with the database name then a
		// pipe-separated metadata tail. Substring match is sufficient.
		expect(dbListExit, 'psql -l should exit 0').toBe(0);
		expect(dbListStdout, 'psql -l stdout missing').not.toBeNull();
		expect(dbListStdout!).toContain('app');
		expect(dbListStdout!).toContain('devstack');

		// TCP probe — `inspectByLabels` returned a non-empty handle,
		// proving the container is up; `psql -lqt` succeeded, proving
		// the daemon is listening on port 5432 inside the per-stack
		// network. The postgres-mini-rewrite config opts NEITHER into
		// `hostPort` nor `route: true`, so there is no host-side TCP
		// port to probe; the in-container exec covers the "daemon is
		// accepting connections" assertion fully.
		expect(pgHandle!.port).toBe(5432);
	}, 180_000);
});
