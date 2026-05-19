// `devstack stack <sub>` — per-app stack management.
//
// A stack is a named, isolated set of state under
// `.devstack/stacks/<name>/`. The active stack name lives in
// `.devstack/active` (single line, no trailing newline normalization).
//
// The state-store (`internal/state-store.ts`) currently writes a flat
// `.devstack/state.json` regardless of stack name. The stack subcommands
// lay down the per-stack directory structure plus the `active` file the
// engine will eventually read. Until that wiring lands, `stack new`/`use`
// are effectively no-ops for the running engine — but they keep the CLI
// surface stable so apps can opt in to multi-stack flows.

import { Console, Effect, FileSystem, Option, Path } from 'effect';
import { Argument, Command, Flag } from 'effect/unstable/cli';
import { ChildProcess, ChildProcessSpawner } from 'effect/unstable/process';
import { join as joinPath } from 'node:path';
import { writeFileAtomic } from '../../engine/atomic-write.js';
import { failAlreadyReported } from '../already-reported.js';
import { wrapCause } from '../loaders.js';
import { DockerLabel } from '../../engine/identity.js';
import { readActiveStack, resolveStack, stateDir } from '../stack-resolution.js';

const ACTIVE_FILE = 'active';

const STACK_NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

type Spawner = ReturnType<typeof ChildProcessSpawner.make>;
type Fs = ReturnType<typeof FileSystem.make>;

const requireValidStackName = (name: string): Effect.Effect<void, Error> =>
	STACK_NAME_RE.test(name)
		? Effect.void
		: Effect.fail(
				new Error(
					`stack: name '${name}' is invalid (must be lowercase + digits + ._-, 1-64 chars)`,
				),
			);

const writeActiveStack = (_fs: Fs, name: string): Effect.Effect<void, Error> =>
	Effect.gen(function* () {
		const activePath = joinPath(stateDir(), ACTIVE_FILE);
		// Atomic via tmp + rename so a concurrent reader (the supervisor
		// resolving its stack name during boot) never sees an empty or
		// half-written `.devstack/active`. `writeFileAtomic` mkdir-p's
		// the parent directory, so a separate `makeDirectory` is no
		// longer needed.
		yield* Effect.tryPromise({
			try: () => writeFileAtomic(activePath, name),
			catch: (cause) => wrapCause(`failed to write ${activePath}`, cause),
		});
	});

// `devstack stack list` — read-only walk of `<DEVSTACK_STATE_DIR>/stacks/`.
const listCommand = Command.make('list', {}, () =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const path = yield* Path.Path;
		const stacksRoot = joinPath(stateDir(), 'stacks');
		const rootExists = yield* fs.exists(stacksRoot).pipe(Effect.orElseSucceed(() => false));
		if (!rootExists) {
			yield* Console.log(`no stacks yet — run \`devstack up\` or \`devstack stack new <name>\``);
			return;
		}
		const entries = yield* fs
			.readDirectory(stacksRoot)
			.pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<string>));
		const dirs: Array<string> = [];
		for (const entry of entries) {
			const full = joinPath(stacksRoot, entry);
			const info = yield* fs.stat(full).pipe(
				Effect.map((s) => s.type === 'Directory'),
				Effect.orElseSucceed(() => false),
			);
			if (info) dirs.push(entry);
		}
		dirs.sort();
		const active = yield* readActiveStack(fs, path);
		if (dirs.length === 0) {
			yield* Console.log(`no stacks under ${stacksRoot}`);
			return;
		}
		for (const name of dirs) {
			const marker = Option.isSome(active) && active.value === name ? '* ' : '  ';
			yield* Console.log(`${marker}${name}`);
		}
	}),
).pipe(Command.withDescription('List all stacks for this app, marking the active one with *'));

// `devstack stack new <name>` — create the per-stack dir. Idempotent.
const newCommand = Command.make(
	'new',
	{
		name: Argument.string('name').pipe(Argument.withDescription('Stack name to create')),
		setActive: Flag.boolean('set-active').pipe(
			Flag.withDescription('Also write this name to .devstack/active'),
			Flag.withDefault(false),
		),
	},
	({ name, setActive }) =>
		Effect.gen(function* () {
			yield* requireValidStackName(name);
			const fs = yield* FileSystem.FileSystem;
			const stackDir = joinPath(stateDir(), 'stacks', name);
			yield* fs
				.makeDirectory(stackDir, { recursive: true })
				.pipe(Effect.mapError((cause) => wrapCause(`failed to create ${stackDir}`, cause)));
			yield* Console.log(`stack '${name}': ready at ${stackDir}`);
			if (setActive) {
				yield* writeActiveStack(fs, name);
				yield* Console.log(`stack '${name}': now active`);
			}
		}),
).pipe(Command.withDescription('Create the per-stack state directory (idempotent)'));

// `devstack stack use <name>` — write `<DEVSTACK_STATE_DIR>/active`.
// mkdir-p's the target dir on the way through.
const useCommand = Command.make(
	'use',
	{ name: Argument.string('name').pipe(Argument.withDescription('Stack to mark active')) },
	({ name }) =>
		Effect.gen(function* () {
			yield* requireValidStackName(name);
			const fs = yield* FileSystem.FileSystem;
			const path = yield* Path.Path;
			const stackDir = joinPath(stateDir(), 'stacks', name);
			yield* fs.makeDirectory(stackDir, { recursive: true }).pipe(Effect.ignore);
			const previous = yield* readActiveStack(fs, path);
			yield* writeActiveStack(fs, name);
			if (Option.isNone(previous)) {
				yield* Console.log(`stack '${name}': now active (no prior default)`);
			} else if (previous.value === name) {
				yield* Console.log(`stack '${name}': already active`);
			} else {
				yield* Console.log(`stack '${name}': now active (was '${previous.value}')`);
			}
		}),
).pipe(Command.withDescription('Set the active stack by writing .devstack/active'));

// `devstack stack down [<name>]` — stop containers for the named stack
// (defaults to active or 'main'). Uses `docker stop`, NOT `docker rm -f`:
// the container's writable layer survives so a follow-up `devstack up`
// resumes via the reuse-if-image-matches probe in `engine/docker/core.ts`
// (~1s warm start). This invariant is load-bearing for snapshots — chain
// state lives in the writable layer (no named volumes hold it), so
// anything that `docker rm` here would lose that state and force a
// genesis rebuild.
//
// `--force` opts into destructive behavior (`docker rm -f`).
// Use that only when you specifically want to throw the writable layer
// away — typically right before `devstack wipe`, or in CI scripts that
// preserve named volumes but rebuild from scratch on every run.
//
// Filters on `label=devstack.stack=<stack>`, which `Docker.run` stamps
// on every container (see `engine/docker/core.ts` + `engine/identity.ts`).
const downCommand = Command.make(
	'down',
	{
		name: Argument.string('name')
			.pipe(Argument.withDescription('Stack name (defaults to active or "main")'))
			.pipe(Argument.optional),
		force: Flag.boolean('force').pipe(
			Flag.withDescription(
				'Destructively `docker rm -f` instead of `docker stop`. Loses the writable ' +
					'layer (chain state, indexer DB). Use only when you intend to start from a ' +
					'clean container next time.',
			),
			Flag.withDefault(false),
		),
	},
	({ name, force }) =>
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;
			const path = yield* Path.Path;
			const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
			const resolved = yield* resolveStack(fs, path, name);
			const verb = force ? 'removing' : 'stopping';
			const pastVerb = force ? 'removed' : 'stopped';
			yield* Console.log(`stack '${resolved}': ${verb} containers${force ? ' (--force)' : ''}`);
			const affected = yield* takeDownContainers(spawner, resolved, force);
			if (affected.length === 0) {
				yield* Console.log(`stack '${resolved}': nothing running to ${force ? 'remove' : 'stop'}`);
			} else {
				for (const id of affected) {
					yield* Console.log(`  ${pastVerb} ${id.slice(0, 12)}`);
				}
				yield* Console.log(
					force
						? `(writable layer destroyed; run \`devstack up\` to rebuild from image)`
						: `(state kept; run \`devstack up\` to resume, or \`devstack stack drop\` to clear)`,
				);
			}
		}),
).pipe(
	Command.withDescription(
		'Stop containers but preserve the writable layer (--force to `docker rm -f` instead)',
	),
);

// `devstack stack drop <name>` — wipe the named stack. Requires --yes.
const dropCommand = Command.make(
	'drop',
	{
		name: Argument.string('name').pipe(Argument.withDescription('Stack to delete')),
		yes: Flag.boolean('yes').pipe(
			Flag.withDescription('Required. Confirms destruction.'),
			Flag.withDefault(false),
		),
	},
	({ name, yes }) =>
		Effect.gen(function* () {
			yield* requireValidStackName(name);
			if (!yes) {
				return yield* failAlreadyReported(
					'devstack stack drop: --yes is required (refusing to drop without explicit confirmation)',
				);
			}
			const fs = yield* FileSystem.FileSystem;
			const stackDir = joinPath(stateDir(), 'stacks', name);
			const exists = yield* fs.exists(stackDir).pipe(Effect.orElseSucceed(() => false));
			if (!exists) {
				yield* Console.log(`stack '${name}': nothing to drop (no dir at ${stackDir})`);
				return;
			}
			yield* fs.remove(stackDir, { recursive: true, force: true }).pipe(Effect.ignore);
			yield* Console.log(`stack '${name}': removed ${stackDir}`);
		}),
).pipe(Command.withDescription('Delete the per-stack state directory. Requires --yes.'));

// Label-filter enumerate-then-(stop|remove). `Docker.run` stamps every
// container with `devstack.stack=<stack>` so this is scoped to the named
// stack and never clobbers siblings.
//
// `force=false` (default): `docker stop` — preserves the writable layer
// so a follow-up `devstack up` adopts the existing container via the
// reuse-if-image-matches probe (~1s resume). This is what the snapshot
// design depends on: chain state lives in the writable layer, so
// `docker rm` here would force a fresh genesis on next boot.
//
// `force=true`: `docker rm -f` — destroys the container including its
// writable layer. Use only when starting from a clean container is the
// goal.
const takeDownContainers = (spawner: Spawner, stack: string, force: boolean) =>
	Effect.gen(function* () {
		const lsCmd = ChildProcess.make('docker', [
			'ps',
			'-aq',
			'--filter',
			`label=${DockerLabel.STACK}=${stack}`,
		]);
		const idsText = yield* spawner.string(lsCmd).pipe(Effect.orElseSucceed(() => ''));
		const ids = idsText
			.split('\n')
			.map((s) => s.trim())
			.filter((s) => s.length > 0);
		const affected: Array<string> = [];
		for (const id of ids) {
			const cmd = ChildProcess.make('docker', force ? ['rm', '-f', id] : ['stop', id]);
			const ok = yield* spawner.string(cmd).pipe(
				Effect.map(() => true),
				Effect.orElseSucceed(() => false),
			);
			if (ok) affected.push(id);
		}
		return affected as ReadonlyArray<string>;
	});

export const stackCommand = Command.make('stack').pipe(
	Command.withDescription('Manage per-app stacks under .devstack/stacks/'),
	Command.withSubcommands([listCommand, newCommand, useCommand, downCommand, dropCommand]),
);
