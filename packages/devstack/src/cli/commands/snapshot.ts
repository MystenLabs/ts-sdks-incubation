// `devstack snapshot <save|restore|list|delete>` — wraps
// `internal/snapshot.ts` with a thin CLI surface. Snapshot ids are
// timestamp-based (UTC, second resolution); an optional `--label` is
// appended via a hyphen to disambiguate ids saved within the same
// second. `restore` accepts either the raw id or a prefix / label.

/* eslint-disable @typescript-eslint/no-explicit-any */

import { Console, Effect, FileSystem, Option, Path } from 'effect';
import { Argument, Command, Flag } from 'effect/unstable/cli';
import { randomBytes } from 'node:crypto';
import { prettyError } from '../../engine/pretty-error.js';
import { list as listSnapshots, restore, snapshot } from '../../engine/snapshot.js';

// Preserve the underlying cause on `Error.cause` so the CLI's top-level
// `tapCause` renderer can walk the full chain rather than collapsing to the
// outer `Error.toString()`.
const wrapCause = (message: string, cause: unknown): Error => {
	const err = new Error(`${message}: ${prettyError(cause).split('\n')[0]}`);
	(err as Error & { cause?: unknown }).cause = cause;
	return err;
};

// Action-time reads of DEVSTACK_STATE_DIR — see manifest.ts for the
// rationale. The engine `snapshot()` / `restore()` / `list()` helpers
// accept a `dir` override; we pass `defaultSnapshotsDir()` explicitly
// so they don't fall back to their own module-load capture either.
const stateDir = (): string => process.env.DEVSTACK_STATE_DIR ?? '.devstack';
const defaultSnapshotsDir = (): string => `${stateDir()}/snapshots`;

// Derive a chronologically-sortable id from the wall clock plus a
// short random suffix so two saves within the same wall-clock second
// (a fixture saving + restoring back-to-back, a user mashing the
// `save` button) produce distinct ids instead of one silently
// overwriting the other.
const makeId = (label: Option.Option<string>): string => {
	const d = new Date();
	const pad = (n: number) => String(n).padStart(2, '0');
	const base =
		`${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}` +
		`T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;
	const suffix = randomBytes(2).toString('hex'); // 4 hex chars
	const stamp = `${base}-${suffix}`;
	return Option.match(label, {
		onNone: () => stamp,
		onSome: (l) => `${stamp}-${l}`,
	});
};

// Pick a snapshot directory from the listing by an exact-id or
// label-fragment match. The id format is `<timestamp>[-<label>]`, so a
// user passing the label they used at save time should land us on the
// right entry; ambiguous matches (two entries sharing a label) refuse
// to choose.
const findMatch = (
	entries: ReadonlyArray<{ id: string; createdAt: number }>,
	ref: string,
): { match?: { id: string; createdAt: number }; ambiguous: boolean } => {
	const exact = entries.find((e) => e.id === ref);
	if (exact !== undefined) return { match: exact, ambiguous: false };
	const labelMatches = entries.filter((e) => {
		const dash = e.id.indexOf('-');
		if (dash === -1) return false;
		return e.id.slice(dash + 1) === ref;
	});
	if (labelMatches.length === 1) return { match: labelMatches[0], ambiguous: false };
	if (labelMatches.length > 1) return { ambiguous: true };
	const prefix = entries.filter((e) => e.id.startsWith(ref));
	if (prefix.length === 1) return { match: prefix[0], ambiguous: false };
	if (prefix.length > 1) return { ambiguous: true };
	return { ambiguous: false };
};

const saveCommand = Command.make(
	'save',
	{
		label: Flag.string('label').pipe(Flag.optional),
	},
	({ label }) =>
		Effect.gen(function* () {
			const id = makeId(label);
			const dir = defaultSnapshotsDir();
			const result = yield* snapshot({ id, dir });
			yield* Console.log(`saved snapshot ${id}`);
			yield* Console.log(`  → ${result.path}`);
		}),
).pipe(Command.withDescription('Capture state.json (and optional container tars) into a snapshot'));

const restoreCommand = Command.make(
	'restore',
	{
		ref: Argument.string('id-or-label').pipe(Argument.optional),
	},
	({ ref }) =>
		Effect.gen(function* () {
			const dir = defaultSnapshotsDir();
			const entries = yield* listSnapshots({ dir });
			if (entries.length === 0) {
				yield* Console.error(`no snapshots in ${dir}`);
				return yield* Effect.fail(new Error('no snapshots to restore'));
			}

			// Default: newest entry (entries are sorted ascending by
			// createdAt; pick the last one).
			const target = Option.match(ref, {
				onNone: () => ({ match: entries[entries.length - 1], ambiguous: false }) as const,
				onSome: (r) => findMatch(entries, r),
			});

			if (target.ambiguous) {
				yield* Console.error(
					`snapshot reference is ambiguous; pass the full id (use \`devstack snapshot list\`)`,
				);
				return yield* Effect.fail(new Error('ambiguous snapshot reference'));
			}
			if (target.match === undefined) {
				yield* Console.error(`no snapshot matching '${Option.getOrElse(ref, () => '')}'`);
				return yield* Effect.fail(new Error('no matching snapshot'));
			}

			const result = yield* restore({ id: target.match.id, dir });
			yield* Console.log(`restored snapshot ${target.match.id}`);
			if (result.loadedImages.length > 0) {
				yield* Console.log(`  loaded images: ${result.loadedImages.join(', ')}`);
			}
		}),
).pipe(Command.withDescription('Restore state.json (and container images) from a snapshot'));

const listCommand = Command.make('list', {}, () =>
	Effect.gen(function* () {
		const dir = defaultSnapshotsDir();
		const entries = yield* listSnapshots({ dir });
		if (entries.length === 0) {
			yield* Console.log(`no snapshots in ${dir}`);
			return;
		}
		yield* Console.log(`snapshots in ${dir}:`);
		// List newest-first — matches v3's UX and matches typical
		// `git log`-style chronology.
		for (let i = entries.length - 1; i >= 0; i--) {
			const entry = entries[i]!;
			const when = new Date(entry.createdAt).toISOString();
			yield* Console.log(`  ${entry.id}  (${when})`);
		}
	}),
).pipe(Command.withDescription('List available snapshots'));

const deleteCommand = Command.make(
	'delete',
	{
		ref: Argument.string('id-or-label'),
	},
	({ ref }) =>
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;
			const path = yield* Path.Path;
			const snapshotsDir = defaultSnapshotsDir();
			const entries = yield* listSnapshots({ dir: snapshotsDir });
			const target = findMatch(entries, ref);
			if (target.ambiguous) {
				yield* Console.error(
					`snapshot reference '${ref}' is ambiguous; pass the full id`,
				);
				return yield* Effect.fail(new Error('ambiguous snapshot reference'));
			}
			if (target.match === undefined) {
				yield* Console.error(`no snapshot matching '${ref}'`);
				return yield* Effect.fail(new Error('no matching snapshot'));
			}
			const targetDir = path.join(snapshotsDir, target.match.id);
			yield* fs
				.remove(targetDir, { recursive: true, force: true })
				.pipe(Effect.mapError((cause) => wrapCause(`failed to remove ${targetDir}`, cause)));
			yield* Console.log(`deleted snapshot ${target.match.id}`);
		}),
).pipe(Command.withDescription('Delete a snapshot directory'));

export const snapshotCommand = Command.make('snapshot').pipe(
	Command.withDescription('Capture / restore labeled snapshots of `.devstack/state.json`'),
	Command.withSubcommands([saveCommand, restoreCommand, listCommand, deleteCommand]),
);
