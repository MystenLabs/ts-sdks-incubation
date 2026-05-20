// `devstack doctor` — preflight checks + inventory.
//
// Two-section report, none of which mutate state:
//
//   - Pre-flight checks: docker daemon, sui CLI, common host ports,
//     stale state-store + move-git locks, fork-specific (when fork
//     stacks exist on disk).
//   - Inventory: every (app, stack) bucket of devstack-labelled docker
//     resources on the machine, plus on-disk state dirs.
//
// Uses a fixed port set (9000, 9123, 9125, 5180) — the state-store
// doesn't record per-snapshot port leases in a shape the CLI can read
// without booting the engine.
//
// Doesn't construct an engine. Safe to run any time. Exits 0 unless
// docker is unreachable (the only required check).
//
// The per-check producers live in `checks-*.ts` siblings; the
// orchestrator `renderChecks` in `_check.ts` handles output rendering
// and the "any required check failed → non-zero exit" contract once.

import { Effect, FileSystem } from 'effect';
import { ChildProcessSpawner } from 'effect/unstable/process';
import { Command, Flag } from 'effect/unstable/cli';
import * as nodeOs from 'node:os';
import * as nodePath from 'node:path';
import { jsonModeEnabled } from '../../envelope.js';
import { resolveStateDir } from '../../stack-resolution.js';
import type { AuditLine, Check } from './_check.js';
import { renderChecks } from './_check.js';
import { checkDocker, checkSui } from './checks-env.js';
import { checkCommonPorts } from './checks-ports.js';
import {
	findStaleLocks,
	listStaleMoveGitLocks,
	moveGitLockCheck,
	removeStaleLocks,
	stateStoreLockCheck,
	sweepStaleGitLocks,
} from './checks-locks.js';
import {
	checkForkDataSizes,
	checkSeedManifests,
	checkSuiForkBinary,
	checkUpstreamGraphql,
	discoverForkStacks,
} from './checks-fork.js';

const cleanLocksFlag = Flag.boolean('clean-locks').pipe(
	Flag.withDescription(
		'Remove dead state-store lock files AND stale `~/.move/git/<repo>/.git/*.lock` ' +
			'files left by crashed `sui move build` runs (default: report only).',
	),
	Flag.withDefault(false),
);

const stateDirOverrideFlag = Flag.string('state-dir').pipe(
	Flag.withDescription(
		'Override DEVSTACK_STATE_DIR for the stale-lock walk. Defaults to ' +
			'<DEVSTACK_APP_DIR>/.devstack/.',
	),
	Flag.optional,
);

export const doctorCommand = Command.make(
	'doctor',
	{
		cleanLocks: cleanLocksFlag,
		stateDirOverride: stateDirOverrideFlag,
		json: Flag.boolean('json').pipe(
			Flag.withDescription('Emit a machine-readable envelope with checks + inventory rows'),
			Flag.withDefault(false),
		),
	},
	({ cleanLocks, stateDirOverride, json }) =>
		Effect.gen(function* () {
			const startedAt = Date.now();
			const useJson = jsonModeEnabled(json);
			const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
			const fs = yield* FileSystem.FileSystem;

			const docker = yield* checkDocker(spawner);
			const sui = yield* checkSui(spawner);
			const ports = yield* checkCommonPorts();

			// Stale state-store locks: each `.devstack/**/state.json.lock`
			// whose holder pid is dead blocks the next `pnpm dev` for that
			// stack with a misleading "already running (pid <dead>)" error.
			// We REPORT them by default and only mutate disk under
			// `--clean-locks` — the prior auto-clean was safe in theory
			// (an orphan can't race itself) but a doctor + mid-write
			// supervisor on the same machine could still misclassify a
			// holder mid-rewrite, and we'd rather a `--clean-locks` opt-in
			// than a defensible-but-surprising default.
			//
			// Honor --state-dir override AND DEVSTACK_STATE_DIR — the latter
			// is read at action-time so a fixture exporting it after CLI
			// import sees the override.
			const stateDir = resolveStateDir({ override: stateDirOverride });
			const staleLocks = yield* findStaleLocks(fs, stateDir);
			const removedLocks = cleanLocks
				? yield* removeStaleLocks(fs, staleLocks)
				: ([] as ReadonlyArray<string>);
			const lockCheck = stateStoreLockCheck({ staleLocks, removedLocks, cleanLocks });

			// Stale `~/.move/git/<repo>/.git/*.lock` files from a previous
			// crashed `sui move build` run. These block the NEXT `sui move
			// build` with `fatal: Unable to create '<repo>/.git/index.lock':
			// File exists` even when nothing is actually racing — the
			// 0-byte lock just survives the SIGKILL'd parent. The engine
			// sweeps these inside `withMoveBuildLock`, but doctor surfaces
			// them so an operator can see the state without booting the
			// engine. Cleaned under `--clean-locks` (same opt-in as the
			// state-store sweep above).
			const moveHome = nodePath.join(nodeOs.homedir(), '.move');
			const staleMoveGitLocks = listStaleMoveGitLocks(moveHome);
			const removedMoveGitLocks = cleanLocks
				? yield* sweepStaleGitLocks(moveHome)
				: ([] as ReadonlyArray<string>);
			const moveGitCheck = moveGitLockCheck({
				staleMoveGitLocks,
				removedMoveGitLocks,
				cleanLocks,
			});

			// Fork-specific checks (P4.11-P4.14). Each is a no-op when no
			// fork stacks are present on disk.
			const forkStacks = yield* discoverForkStacks(fs, stateDir);
			const suiForkCheck = yield* checkSuiForkBinary(spawner, false);
			const upstreams = Array.from(new Set(forkStacks.map((s) => s.upstream)));
			const graphqlCheck = yield* checkUpstreamGraphql(upstreams);
			const seedCheck = yield* checkSeedManifests(forkStacks);
			const dataSizeCheck = yield* Effect.promise(() => checkForkDataSizes(forkStacks));

			const all: ReadonlyArray<Check> = [
				docker,
				sui,
				lockCheck,
				moveGitCheck,
				...ports,
				suiForkCheck,
				graphqlCheck,
				seedCheck,
				dataSizeCheck,
			];

			// Audit-lines: one block per cleaned-lock anchor. Renders as
			// `      └─ {path}{extra}` after the checks list (text mode
			// only; the JSON envelope already exposes detail strings).
			const stateLockAuditLines: ReadonlyArray<AuditLine> = staleLocks
				.filter((lock) => removedLocks.includes(lock.path))
				.map((lock) => {
					const pidLabel = lock.pid !== undefined ? `pid ${lock.pid}` : 'unreadable holder';
					const ageLabel = lock.acquiredAt !== undefined ? `, acquired ${lock.acquiredAt}` : '';
					return { path: lock.path, extra: `(${pidLabel}${ageLabel})` };
				});
			const moveLockAuditLines: ReadonlyArray<AuditLine> = removedMoveGitLocks.map((p) => ({
				path: p,
			}));

			yield* renderChecks({
				checks: all,
				useJson,
				startedAt,
				includeInventory: docker.ok,
				auditLines: [stateLockAuditLines, moveLockAuditLines],
			});
		}),
).pipe(
	Command.withDescription(
		'Preflight checks + inventory of devstack-labelled docker resources',
	),
);
