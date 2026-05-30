// Regression: prune liveness must see a live stack via its RUNNING
// containers, not the roster alone.
//
// The bug: `collectLifecyclePruneInventory` classified a normal (non-
// router) group's liveness SOLELY from the per-stack roster's live-PID
// set (`livePids.length > 0`). A stack with a live `devstack up`
// supervisor — running containers + a live process — was reported
// `live: false` / `livePids: []` whenever the roster probe came back
// empty (a missing/stale roster file, a holder reaped by a peer sweep,
// or a `ps -o lstart` start-time hiccup that harvested a live holder as
// dead). `prune --list` then showed the live stack as idle, and
// `prune --all`'s default selection (`defaultLifecyclePruneSelection`)
// would have queued the live stack's resources for removal — it was
// protected ONLY because the group was also non-`autoPrunable`.
//
// The fix: a normal group is live when its roster carries a live holder
// OR the Docker daemon reports a RUNNING container for it — the SAME
// `runningContainers > 0` signal the router branch already used. Running
// containers are a daemon-authoritative "not idle" signal, so a live
// supervisor's stack is always `live: true` and excluded from `--all`.
//
// Seam (no source change): `collectLifecyclePruneInventory` provides its
// own docker layer internally, so the reachable seam is the PATH-resolved
// `docker` binary. We stub `docker ps` to report ONE running container
// for `(arena, main)` and write NO roster.json — so the roster-PID probe
// yields an empty set and the ONLY remaining liveness signal is the
// running container. Pre-fix code reports `live: false`; post-fix
// reports `live: true`.

import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';

import { Effect } from 'effect';
import { afterEach, describe, expect, it } from 'vitest';

import {
	collectLifecyclePruneInventory,
	defaultLifecyclePruneSelection,
	lifecyclePruneGroupKey,
	DEFAULT_LIFECYCLE_PRUNE_RESOURCES,
} from '../../../src/orchestrators/lifecycle-prune/index.ts';

const APP = 'arena';
const STACK = 'main';
const CONTAINER_NAME = `devstack-${APP}-${STACK}-svc`;

const BASE_LABELS = `devstack.managed=true,devstack.app=${APP},devstack.stack=${STACK}`;
const RUNNING_PS_LINE = JSON.stringify({
	ID: 'container-id',
	Names: CONTAINER_NAME,
	Image: 'arena-svc:test',
	Status: 'Up 3 minutes',
	State: 'running',
	Labels: BASE_LABELS,
});

const restorers: Array<() => void> = [];

afterEach(() => {
	for (const restore of restorers.splice(0)) restore();
});

// `docker ps` reports one RUNNING container for the group; the router-kind
// inventory pass and the network/volume/image lists stay empty. No `rm`
// verbs are exercised here — this test only inspects classification.
const writeDockerStub = (binPath: string): void => {
	writeFileSync(
		binPath,
		[
			'#!/bin/sh',
			'if [ "$1" = "ps" ]; then',
			'  case "$*" in',
			'    *devstack.kind=router*) : ;;',
			`    *) printf '%s\\n' ${JSON.stringify(RUNNING_PS_LINE)} ;;`,
			'  esac',
			'  exit 0',
			'fi',
			'if [ "$1" = "network" ] && [ "$2" = "ls" ]; then exit 0; fi',
			'if [ "$1" = "volume" ] && [ "$2" = "ls" ]; then exit 0; fi',
			'if [ "$1" = "images" ]; then exit 0; fi',
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
	restorers.push(() => {
		if (original === undefined) delete process.env.PATH;
		else process.env.PATH = original;
	});
};

describe('lifecycle-prune liveness via running containers', () => {
	it('reports a running-container stack as live even with no roster, and excludes it from --all', async () => {
		const root = mkdtempSync(join('/tmp', 'lifecycle-prune-live-'));
		try {
			const binDir = join(root, 'bin');
			mkdirSync(binDir, { recursive: true });
			writeDockerStub(join(binDir, 'docker'));
			prependToPath(binDir);

			// Deliberately NO `stacks/<stack>/roster.json` — the roster-PID
			// probe yields an empty set, so running containers are the only
			// liveness signal. This mirrors the observed failure (a live
			// supervisor whose roster probe came back empty).

			const inventory = await Effect.runPromise(
				collectLifecyclePruneInventory({ runtimeRoot: root }),
			);

			const key = lifecyclePruneGroupKey(APP, STACK);
			const group = inventory.groups.find((g) => g.key === key);
			expect(group).toBeDefined();
			// Running container present...
			expect(group!.runningContainers).toBe(1);
			// ...and no live roster PID...
			expect(group!.livePids).toEqual([]);
			// ...yet the group is classified LIVE (the fix).
			expect(group!.live).toBe(true);

			// And `prune --all`'s default selection excludes it: a live stack
			// is never queued for removal.
			const selection = defaultLifecyclePruneSelection(
				inventory,
				DEFAULT_LIFECYCLE_PRUNE_RESOURCES,
			);
			expect(selection).not.toContain(key);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it('still reports an idle stack (exited containers, no roster) as not live', async () => {
		const root = mkdtempSync(join('/tmp', 'lifecycle-prune-idle-'));
		try {
			const binDir = join(root, 'bin');
			mkdirSync(binDir, { recursive: true });
			// An EXITED container for the same group — no running container,
			// no roster: the group must remain idle so `--all` can reclaim it.
			const exitedLine = JSON.stringify({
				ID: 'container-id',
				Names: CONTAINER_NAME,
				Image: 'arena-svc:test',
				Status: 'Exited (0) 5 minutes ago',
				State: 'exited',
				Labels: BASE_LABELS,
			});
			writeFileSync(
				join(binDir, 'docker'),
				[
					'#!/bin/sh',
					'if [ "$1" = "ps" ]; then',
					'  case "$*" in',
					'    *devstack.kind=router*) : ;;',
					`    *) printf '%s\\n' ${JSON.stringify(exitedLine)} ;;`,
					'  esac',
					'  exit 0',
					'fi',
					'if [ "$1" = "network" ] && [ "$2" = "ls" ]; then exit 0; fi',
					'if [ "$1" = "volume" ] && [ "$2" = "ls" ]; then exit 0; fi',
					'if [ "$1" = "images" ]; then exit 0; fi',
					'exit 0',
					'',
				].join('\n'),
				'utf8',
			);
			chmodSync(join(binDir, 'docker'), 0o755);
			prependToPath(binDir);

			const inventory = await Effect.runPromise(
				collectLifecyclePruneInventory({ runtimeRoot: root }),
			);
			const key = lifecyclePruneGroupKey(APP, STACK);
			const group = inventory.groups.find((g) => g.key === key);
			expect(group).toBeDefined();
			expect(group!.runningContainers).toBe(0);
			expect(group!.livePids).toEqual([]);
			expect(group!.live).toBe(false);

			// Idle: the default `--all` selection DOES include it.
			const selection = defaultLifecyclePruneSelection(
				inventory,
				DEFAULT_LIFECYCLE_PRUNE_RESOURCES,
			);
			expect(selection).toContain(key);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
