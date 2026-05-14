// Post-`Layer.build` orphan sweep + the `ClaimedContainers` reference
// the run helper writes into. Lives in its own file so the
// `Context.Reference` doesn't import the run/exec/image stacks (which
// would build an import cycle once `core.ts` claims into the same Ref).

import { Context, Effect, Ref } from 'effect';
import { ChildProcess, ChildProcessSpawner } from 'effect/unstable/process';
import { composeProjectName } from './core.js';

// Set of container IDs this process has adopted-or-created. Populated by
// `Docker.run` (both the reuse-if-healthy path and the fresh-create path)
// and read by `dockerOrphanSweep` after `Layer.build` to identify which
// compose-project-labelled containers belong to primitives that were
// REMOVED from the config since the last run. Default `undefined` so
// standalone callers (tests, ad-hoc `Docker.run` outside a devstack)
// stay unaffected by this tracking.
export const ClaimedContainers = Context.Reference<Ref.Ref<Set<string>> | undefined>(
	'@devstack/ClaimedContainers',
	{ defaultValue: () => undefined },
);

// Post-`Layer.build` orphan sweep. Enumerates every container labelled with
// this stack's compose-project tag and `docker rm -f`s any that the current
// process did NOT adopt-or-create (i.e. its `containerId` is absent from
// the `claimed` set). Called once per `defineDevstack.run` cycle AFTER the
// layer build, so `Docker.run`'s reuse-if-healthy probe has had its chance
// to adopt prior-process containers whose primitives are still in the
// config. Anything left over belongs to a primitive that was REMOVED from
// the config since the last run, or was orphaned by a crashed prior
// process (SIGKILL → finalizers didn't fire) — both safe to reap.
//
// Best-effort throughout — a `docker` daemon that's unreachable returns
// an empty list and we proceed; the run path will surface a real error
// if docker is actually down.
//
// Pre-build sweeping is the WRONG layering: it nukes still-healthy
// containers (e.g. `sui.localnet` from a previous process) BEFORE
// `Docker.run` gets a chance to adopt them, which forces a fresh Sui
// genesis → new chain id → publishMove cache miss → NEW packageId on
// every process restart. Moving the sweep to post-build is the fix.
export const dockerOrphanSweep = (
	app: string,
	stack: string,
	network: string,
	claimed: ReadonlySet<string>,
): Effect.Effect<ReadonlyArray<string>, never, ChildProcessSpawner.ChildProcessSpawner> =>
	Effect.gen(function* () {
		const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
		const composeProject = composeProjectName(app, stack, network);
		// Belt-and-braces filter: `com.docker.compose.project` alone could collide
		// with an unrelated `docker compose` project on the host whose name happens
		// to match ours (e.g. another tool's `wallet` stack) — a false-positive
		// would `docker rm -f` THEIR containers. Anding with the two devstack-only
		// labels stamped by `Docker.run` (`core.ts:191-192`) means a match requires
		// all three labels to line up, which is effectively impossible to hit by
		// accident outside this package. `docker ps --filter label=...` is an
		// AND-conjunction across repeats, exactly what we want.
		const lsCmd = ChildProcess.make('docker', [
			'ps',
			'-aq',
			'--filter',
			`label=com.docker.compose.project=${composeProject}`,
			'--filter',
			`label=devstack.app=${app}`,
			'--filter',
			`label=devstack.stack=${stack}`,
		]);
		const idsText = yield* spawner.string(lsCmd).pipe(Effect.catch(() => Effect.succeed('')));
		const ids = idsText
			.split('\n')
			.map((s) => s.trim())
			.filter((s) => s.length > 0);
		const removed: Array<string> = [];
		for (const id of ids) {
			// `docker ps -q` emits short ids (12 chars); `Docker.run` records
			// FULL ids (64 hex). Match by short-form prefix so the claim set
			// can be checked against either form without needing a second
			// `inspect` per container.
			const isClaimed = (() => {
				for (const c of claimed) {
					if (c === id || c.startsWith(id) || id.startsWith(c)) return true;
				}
				return false;
			})();
			if (isClaimed) continue;
			const ok = yield* spawner
				.exitCode(ChildProcess.make('docker', ['rm', '-f', id]))
				.pipe(
					Effect.map(() => true),
					Effect.catch(() => Effect.succeed(false)),
				);
			if (ok) removed.push(id);
		}

		// Orphan networks left by a prior process killed mid-cycle — the
		// network's `rm` finalizer never ran, so a fresh `network create`
		// at the same `--subnet` fails with "Pool overlaps with other one
		// on this address space" even though no container is attached.
		// Filter on the same compose-project label `Docker.networkCreate`
		// stamps. Best-effort throughout.
		// Same belt-and-braces tightening as the container filter above —
		// `Docker.networkCreate` stamps `devstack.app` + `devstack.stack`
		// alongside the compose-project label (`network.ts:61-62`), so
		// ANDing all three filters keeps us from racing an unrelated host
		// project that happened to pick the same compose-project name.
		const lsNetCmd = ChildProcess.make('docker', [
			'network',
			'ls',
			'-q',
			'--filter',
			`label=com.docker.compose.project=${composeProject}`,
			'--filter',
			`label=devstack.app=${app}`,
			'--filter',
			`label=devstack.stack=${stack}`,
		]);
		const netIdsText = yield* spawner.string(lsNetCmd).pipe(Effect.catch(() => Effect.succeed('')));
		const netIds = netIdsText
			.split('\n')
			.map((s) => s.trim())
			.filter((s) => s.length > 0);
		for (const id of netIds) {
			const ok = yield* spawner
				.exitCode(ChildProcess.make('docker', ['network', 'rm', id]))
				.pipe(
					Effect.map(() => true),
					Effect.catch(() => Effect.succeed(false)),
				);
			if (ok) removed.push(id);
		}
		return removed as ReadonlyArray<string>;
	}).pipe(Effect.withSpan('Docker.orphanSweep'));
