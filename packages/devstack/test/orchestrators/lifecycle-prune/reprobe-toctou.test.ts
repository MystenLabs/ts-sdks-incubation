// Regression: `runLifecyclePrune` re-probes per-stack liveness IMMEDIATELY
// before committing each non-router group to removal, and SKIPS any group
// that came alive since the one-time inventory pass.
//
// The TOCTOU: `collectLifecyclePruneInventory` probes each stack's
// roster ONCE at the top of the run. A stack that boots concurrently (a
// `devstack up` of a previously-dead stack) in the window between that
// snapshot and the removal loop would otherwise have its
// containers/networks/volumes force-removed out from under the
// freshly-started supervisor. The fix re-runs the SAME liveness helper
// (`livePidsForStack`) per non-router victim just before removal and
// drops it from the prune set if it is now live (see
// `orchestrators/lifecycle-prune/index.ts` — the "TOCTOU close" block in
// `runLifecyclePrune`).
//
// Seam (no source change): `livePidsForStack` reads
// `<runtimeRoot>/stacks/<stack>/roster.json` and, for each holder,
// confirms identity via the substrate liveness probe — `process.kill(pid,
// 0)` for pid-in-use AND `ps -o lstart= -p <pid>` to defend against
// PID reuse (the recorded `startTime` is the FNV-1a hash of that
// `ps` output; see `substrate/runtime/cross-process/liveness.ts`). The
// orchestrator provides its own docker + liveness-probe-scope layers
// internally, so neither can be overridden by an outer layer; the
// reachable seams are therefore the PATH-resolved `docker`/`ps`
// binaries, a real on-disk roster, and a real OS process.
//
// We exploit the `ps` start-time fork: the roster carries one holder
// whose `pid` is a REAL live child process (so `process.kill(pid, 0)`
// always succeeds) but whose recorded `startTime` matches the SECOND
// `ps` invocation's stamp, not the first. The inventory probe (call #1)
// reads a non-matching stamp → the holder is classified DEAD → the group
// is a prune candidate. The re-probe (call #2) reads the matching stamp →
// the holder is LIVE → the group is SKIPPED. This is precisely the
// dead-at-inventory / live-at-re-probe transition the fix guards.
//
// Pre-fix code (no re-probe block) calls `livePidsForStack` ONCE, sees
// only the inventory DEAD verdict, pushes the group to the prune set, and
// removes its container/network/volume — so the assertions below
// (`skippedLiveGroups === 1`, zero removals, `ps` forked twice) FAIL on
// pre-fix code and PASS on current code.

import { spawn, type ChildProcess } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { hostname as nodeHostname } from 'node:os';
import { delimiter, join } from 'node:path';

import { Effect } from 'effect';
import { afterEach, describe, expect, it } from 'vitest';

import {
	lifecyclePruneGroupKey,
	runLifecyclePrune,
	type LifecyclePruneSelection,
} from '../../../src/orchestrators/lifecycle-prune/index.ts';

const APP = 'arena';
const STACK = 'main';
const CONTAINER_NAME = `devstack-${APP}-${STACK}-svc`;
const NETWORK_NAME = `devstack-${APP}-${STACK}`;
const VOLUME_NAME = `devstack-${APP}-${STACK}-data`;

// Inventory label tuple every resource for the group carries — the L1
// listers filter on `devstack.app` and the orchestrator buckets on
// `(devstack.app, devstack.stack)`.
const BASE_LABELS = `devstack.managed=true,devstack.app=${APP},devstack.stack=${STACK}`;
const PS_LINE = JSON.stringify({
	ID: 'container-id',
	Names: CONTAINER_NAME,
	Image: 'arena-svc:test',
	Status: 'Exited (0) 5 minutes ago',
	State: 'exited',
	Labels: BASE_LABELS,
});
const NETWORK_LINE = JSON.stringify({
	ID: 'network-id',
	Name: NETWORK_NAME,
	Driver: 'bridge',
	Labels: `${BASE_LABELS},devstack.network=true`,
});
const VOLUME_LINE = JSON.stringify({
	Name: VOLUME_NAME,
	Driver: 'local',
	Mountpoint: `/var/lib/docker/volumes/${VOLUME_NAME}/_data`,
	Labels: `${BASE_LABELS},devstack.volume=true`,
});

// FNV-1a 32-bit — must match `liveness.hashStartTimeStamp` exactly so the
// recorded `startTime` equals the hash of the stamp our shadow `ps`
// prints on its SECOND invocation.
const fnv1a32 = (stamp: string): number => {
	let h = 2166136261;
	for (let i = 0; i < stamp.length; i++) {
		h ^= stamp.charCodeAt(i);
		h = (h * 16777619) >>> 0;
	}
	return h >>> 0;
};

const REPROBE_MATCH_STAMP = 'Wed May 28 12:00:00 2026';
const INVENTORY_MISMATCH_STAMP = 'Tue Jan 01 00:00:00 2019';

const ALL_RESOURCES_NO_IMAGES = {
	containers: true,
	networks: true,
	volumes: true,
	images: false,
} as const;

const live: { children: Array<ChildProcess>; restorePath: Array<() => void> } = {
	children: [],
	restorePath: [],
};

afterEach(() => {
	for (const child of live.children.splice(0)) child.kill('SIGKILL');
	for (const restore of live.restorePath.splice(0)) restore();
});

// Write the PATH-resolved `docker` stub: emits the dead-group inventory
// for `ps`/`network ls`/`volume ls`, succeeds for every `rm`-family verb
// (so removals would COUNT if the group were ever committed), and logs
// each invocation's argv so we can prove the removal verbs never fired.
const writeDockerStub = (binPath: string, logPath: string): void => {
	writeFileSync(
		binPath,
		[
			'#!/bin/sh',
			`printf '%s\\n' "$*" >> ${JSON.stringify(logPath)}`,
			'if [ "$1" = "ps" ]; then',
			// Router-kind inventory pass must stay empty (no router group).
			'  case "$*" in',
			'    *devstack.kind=router*) : ;;',
			`    *) printf '%s\\n' ${JSON.stringify(PS_LINE)} ;;`,
			'  esac',
			'  exit 0',
			'fi',
			'if [ "$1" = "network" ] && [ "$2" = "ls" ]; then',
			`  printf '%s\\n' ${JSON.stringify(NETWORK_LINE)}`,
			'  exit 0',
			'fi',
			'if [ "$1" = "volume" ] && [ "$2" = "ls" ]; then',
			`  printf '%s\\n' ${JSON.stringify(VOLUME_LINE)}`,
			'  exit 0',
			'fi',
			'if [ "$1" = "images" ]; then exit 0; fi',
			// Removal verbs — succeed so a (wrongly) committed group would
			// register a real removal. They MUST NOT be reached.
			'if [ "$1" = "rm" ]; then exit 0; fi',
			'if [ "$1" = "network" ] && [ "$2" = "rm" ]; then exit 0; fi',
			'if [ "$1" = "volume" ] && [ "$2" = "rm" ]; then exit 0; fi',
			'exit 0',
			'',
		].join('\n'),
		'utf8',
	);
	chmodSync(binPath, 0o755);
};

// Write the PATH-resolved `ps` stub used by the substrate liveness probe
// (`ps -o lstart= -p <pid>`). Returns a NON-matching start-time stamp on
// the first invocation (inventory probe → holder reads DEAD) and the
// MATCHING stamp on every later invocation (re-probe → holder reads
// LIVE). A persisted counter file makes the flip survive across the two
// separate `livePidsForStack` calls.
const writePsStub = (binPath: string, counterPath: string): void => {
	writeFileSync(
		binPath,
		[
			'#!/bin/sh',
			`n=$(cat ${JSON.stringify(counterPath)} 2>/dev/null || echo 0)`,
			'n=$((n + 1))',
			`printf '%s' "$n" > ${JSON.stringify(counterPath)}`,
			'if [ "$n" -eq 1 ]; then',
			`  printf '%s\\n' ${JSON.stringify(INVENTORY_MISMATCH_STAMP)}`,
			'else',
			`  printf '%s\\n' ${JSON.stringify(REPROBE_MATCH_STAMP)}`,
			'fi',
			'exit 0',
			'',
		].join('\n'),
		'utf8',
	);
	chmodSync(binPath, 0o755);
};

const prependToPath = (dir: string): void => {
	const original = process.env.PATH;
	process.env.PATH = `${dir}${delimiter}${original ?? ''}`;
	live.restorePath.push(() => {
		if (original === undefined) delete process.env.PATH;
		else process.env.PATH = original;
	});
};

describe('runLifecyclePrune liveness re-probe (TOCTOU close)', () => {
	it('skips a group dead at inventory but live at re-probe; removes nothing', async () => {
		const root = mkdtempSync(join('/tmp', 'lifecycle-prune-reprobe-'));
		try {
			const binDir = join(root, 'bin');
			mkdirSync(binDir, { recursive: true });
			const dockerLog = join(root, 'docker.log');
			const psCounter = join(root, 'ps-call-count');
			writeDockerStub(join(binDir, 'docker'), dockerLog);
			writePsStub(join(binDir, 'ps'), psCounter);

			// A real long-lived child: `process.kill(childPid, 0)` always
			// succeeds, so the DEAD/LIVE verdict is decided purely by the
			// start-time stamp our shadow `ps` returns — flipping with the
			// probe-call ordinal, not with whether the pid is in use.
			const child = spawn('sleep', ['30'], { stdio: 'ignore' });
			live.children.push(child);
			const childPid = child.pid;
			expect(childPid).toBeGreaterThan(0);

			// Roster present for BOTH reads. `startTime` matches the re-probe
			// (call #2) stamp's FNV hash, NOT the inventory (call #1) stamp.
			const stackRoot = join(root, 'stacks', STACK);
			mkdirSync(stackRoot, { recursive: true });
			writeFileSync(
				join(stackRoot, 'roster.json'),
				JSON.stringify({
					version: 1,
					holders: [
						{
							pid: childPid,
							startTime: fnv1a32(REPROBE_MATCH_STAMP),
							hostname: nodeHostname(),
							claimedAt: Date.now(),
							heartbeatAt: Date.now(),
							intent: 'normal',
						},
					],
				}),
				'utf8',
			);

			prependToPath(binDir);

			// Caller explicitly selects the group (the same shape a scripted
			// `devstack prune --all` builds). It is dead at inventory, so it
			// is NOT dropped by the live-skip or pin-enforcement filters — it
			// reaches the removal loop, where the re-probe must catch it.
			const selection: LifecyclePruneSelection = {
				groupKeys: [lifecyclePruneGroupKey(APP, STACK)],
				resources: ALL_RESOURCES_NO_IMAGES,
				dryRun: false,
			};

			const summary = await Effect.runPromise(runLifecyclePrune({ runtimeRoot: root }, selection));

			// The group reached the removal loop (inventory classified it
			// dead) but the re-probe found it live and skipped it.
			expect(summary.inspectedGroups).toBe(1);
			expect(summary.skippedLiveGroups).toBe(1);
			expect(summary.selectedGroups).toBe(0);

			// Nothing was removed.
			expect(summary.containersRemoved).toBe(0);
			expect(summary.networksRemoved).toBe(0);
			expect(summary.volumesRemoved).toBe(0);
			expect(summary.imagesRemoved).toBe(0);

			// The re-probe actually happened: `livePidsForStack` forked `ps`
			// TWICE (inventory + re-probe). Pre-fix code forks it once.
			expect(readFileSync(psCounter, 'utf8')).toBe('2');

			// And no removal verb was ever dispatched to docker — the group's
			// resources survive intact.
			const dockerCalls = readFileSync(dockerLog, 'utf8');
			expect(dockerCalls).not.toMatch(/(^|\n)rm /);
			expect(dockerCalls).not.toMatch(/network rm /);
			expect(dockerCalls).not.toMatch(/volume rm /);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
