// `devstack stack <sub>` — per-app stack management.
//
// V3 parity port. A stack is a named, isolated set of state under
// `.devstack/stacks/<name>/`. The active stack name lives in
// `.devstack/active` (single line, no trailing newline normalization).
//
// V4 caveat: the current state-store (`internal/state-store.ts`) writes a
// flat `.devstack/state.json` regardless of stack name. The stack
// subcommands lay down the per-stack directory structure that a future
// stack-aware state store will consume, plus the `active` file the engine
// will eventually read. Until that wiring lands, `stack new`/`use` are
// effectively no-ops for the running engine — but they keep the CLI surface
// stable so apps can opt in to multi-stack flows as soon as the runtime
// supports them.

import { Console, Effect, FileSystem, Option } from 'effect';
import { Argument, Command, Flag } from 'effect/unstable/cli';
import { ChildProcess, ChildProcessSpawner } from 'effect/unstable/process';
import { join as joinPath } from 'node:path';
import { writeFileAtomic } from '../../engine/atomic-write.js';
import { prettyError } from '../../engine/pretty-error.js';

// Preserve the underlying cause on `Error.cause` so the CLI's top-level
// `tapCause` renderer can walk the full chain (PlatformError → ENOENT path,
// etc.) instead of flattening to the outer `Error.toString()`.
const wrapCause = (message: string, cause: unknown): Error => {
	const err = new Error(`${message}: ${prettyError(cause).split('\n')[0]}`);
	(err as Error & { cause?: unknown }).cause = cause;
	return err;
};

// Read DEVSTACK_STATE_DIR at action-time so any per-test or shell
// override applied after module-load is honored.
const stateDir = (): string => process.env.DEVSTACK_STATE_DIR ?? '.devstack';

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

const readActiveStack = (fs: Fs): Effect.Effect<Option.Option<string>> =>
	Effect.gen(function* () {
		const activePath = joinPath(stateDir(), ACTIVE_FILE);
		const exists = yield* fs.exists(activePath).pipe(Effect.catch(() => Effect.succeed(false)));
		if (!exists) return Option.none<string>();
		const txt = yield* fs.readFileString(activePath).pipe(Effect.catch(() => Effect.succeed('')));
		const trimmed = txt.trim();
		return trimmed.length === 0 ? Option.none<string>() : Option.some(trimmed);
	});

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
		const stacksRoot = joinPath(stateDir(), 'stacks');
		const rootExists = yield* fs.exists(stacksRoot).pipe(Effect.catch(() => Effect.succeed(false)));
		if (!rootExists) {
			yield* Console.log(`no stacks yet — run \`devstack up\` or \`devstack stack new <name>\``);
			return;
		}
		const entries = yield* fs
			.readDirectory(stacksRoot)
			.pipe(Effect.catch(() => Effect.succeed([] as ReadonlyArray<string>)));
		const dirs: Array<string> = [];
		for (const entry of entries) {
			const full = joinPath(stacksRoot, entry);
			const info = yield* fs.stat(full).pipe(
				Effect.map((s) => s.type === 'Directory'),
				Effect.catch(() => Effect.succeed(false)),
			);
			if (info) dirs.push(entry);
		}
		dirs.sort();
		const active = yield* readActiveStack(fs);
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

// `devstack stack use <name>` — write `<DEVSTACK_STATE_DIR>/active`. mkdir-p's the
// target dir on the way through, mirroring v3.
const useCommand = Command.make(
	'use',
	{ name: Argument.string('name').pipe(Argument.withDescription('Stack to mark active')) },
	({ name }) =>
		Effect.gen(function* () {
			yield* requireValidStackName(name);
			const fs = yield* FileSystem.FileSystem;
			const stackDir = joinPath(stateDir(), 'stacks', name);
			yield* fs.makeDirectory(stackDir, { recursive: true }).pipe(Effect.catch(() => Effect.void));
			const previous = yield* readActiveStack(fs);
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

// `devstack stack down [<name>]` — best-effort stop containers for the
// named stack (defaults to active or 'main'). State on disk is preserved
// so a follow-up `up` resumes. Filters on `label=devstack.stack=<stack>`,
// which `Docker.run` stamps on every container (see
// `internal/docker.ts` + `internal/identity.ts`).
const downCommand = Command.make(
	'down',
	{
		name: Argument.string('name')
			.pipe(Argument.withDescription('Stack name (defaults to active or "main")'))
			.pipe(Argument.optional),
	},
	({ name }) =>
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;
			const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
			const resolved = yield* resolveStackName(fs, name);
			yield* Console.log(`stack '${resolved}': stopping containers`);
			const killed = yield* stopDevstackContainers(spawner, resolved);
			if (killed.length === 0) {
				yield* Console.log(`stack '${resolved}': nothing running to stop`);
			} else {
				for (const id of killed) {
					yield* Console.log(`  stopped ${id.slice(0, 12)}`);
				}
				yield* Console.log(
					`(state kept; run \`devstack up\` to resume, or \`devstack stack drop\` to clear)`,
				);
			}
		}),
).pipe(Command.withDescription('Stop containers but preserve on-disk state'));

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
				yield* Console.error(
					'devstack stack drop: --yes is required (refusing to drop without explicit confirmation)',
				);
				return yield* Effect.fail(new Error('stack drop: --yes required'));
			}
			const fs = yield* FileSystem.FileSystem;
			const stackDir = joinPath(stateDir(), 'stacks', name);
			const exists = yield* fs.exists(stackDir).pipe(Effect.catch(() => Effect.succeed(false)));
			if (!exists) {
				yield* Console.log(`stack '${name}': nothing to drop (no dir at ${stackDir})`);
				return;
			}
			yield* fs
				.remove(stackDir, { recursive: true, force: true })
				.pipe(Effect.catch(() => Effect.void));
			yield* Console.log(`stack '${name}': removed ${stackDir}`);
		}),
).pipe(Command.withDescription('Delete the per-stack state directory. Requires --yes.'));

const resolveStackName = (fs: Fs, provided: Option.Option<string>): Effect.Effect<string> =>
	Effect.gen(function* () {
		if (Option.isSome(provided)) return provided.value;
		const active = yield* readActiveStack(fs);
		return Option.getOrElse(active, () => 'main');
	});

// Label-filter enumerate-then-rm. Mirrors `wipe`'s
// `killDevstackContainers` — `Docker.run` stamps every container with
// `devstack.stack=<stack>` so a stop here is scoped to the named stack
// instead of clobbering siblings.
const stopDevstackContainers = (spawner: Spawner, stack: string) =>
	Effect.gen(function* () {
		const lsCmd = ChildProcess.make('docker', [
			'ps',
			'-aq',
			'--filter',
			`label=devstack.stack=${stack}`,
		]);
		const idsText = yield* spawner.string(lsCmd).pipe(Effect.catch(() => Effect.succeed('')));
		const ids = idsText
			.split('\n')
			.map((s) => s.trim())
			.filter((s) => s.length > 0);
		const killed: Array<string> = [];
		for (const id of ids) {
			const rmCmd = ChildProcess.make('docker', ['rm', '-f', id]);
			const ok = yield* spawner.string(rmCmd).pipe(
				Effect.map(() => true),
				Effect.catch(() => Effect.succeed(false)),
			);
			if (ok) killed.push(id);
		}
		return killed as ReadonlyArray<string>;
	});

export const stackCommand = Command.make('stack').pipe(
	Command.withDescription('Manage per-app stacks under .devstack/stacks/'),
	Command.withSubcommands([listCommand, newCommand, useCommand, downCommand, dropCommand]),
);
