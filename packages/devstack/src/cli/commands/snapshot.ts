// `devstack snapshot <save|restore|list|delete>` — wraps
// `internal/snapshot.ts` with a thin CLI surface.
//
// Save flow (Phase 3.6 of the snapshot redesign):
//   1. Resolve active stack via `.devstack/active` (or `--stack <name>`).
//   2. Enumerate containers labelled `devstack.stack=<stack>` via
//      `docker ps`. Their `{id, name}` tuples feed into the engine
//      `snapshot()` which `docker commit + save`s each into the
//      snapshot dir.
//   3. The engine also tars the canonical `runtime/<service>/...` dir
//      and any opt-in extras registered via `ServicePaths.addExtra`.
//   4. `state.json` is copied verbatim.
//
// Snapshot ids are timestamp-based (UTC, second resolution); an
// optional `--label` is appended via a hyphen to disambiguate ids
// saved within the same second. `restore` accepts either the raw id
// or a prefix / label.

/* eslint-disable @typescript-eslint/no-explicit-any */

import { Console, Effect, FileSystem, Option, Path } from 'effect';
import { Argument, Command, Flag } from 'effect/unstable/cli';
import { ChildProcess, ChildProcessSpawner } from 'effect/unstable/process';
import { randomBytes } from 'node:crypto';
import { wrapCause } from '../loaders.js';
import { failAlreadyReported } from '../already-reported.js';
import { resolveStack, stateDir } from '../stack-resolution.js';
import { deriveAppName, DockerLabel } from '../../engine/identity.js';
import { list as listSnapshots, restore, snapshot } from '../../engine/snapshot.js';

// Action-time reads of DEVSTACK_STATE_DIR — see manifest.ts for the
// rationale. The engine `snapshot()` / `restore()` / `list()` helpers
// accept a `dir` override; we pass `defaultSnapshotsDir()` explicitly
// so they don't fall back to their own module-load capture either.
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
	entries: ReadonlyArray<{ id: string; createdAt: number; stack?: string; network?: string }>,
	ref: string,
): {
	match?: { id: string; createdAt: number; stack?: string; network?: string };
	ambiguous: boolean;
} => {
	const exact = entries.find((e) => e.id === ref);
	if (exact !== undefined) return { match: exact, ambiguous: false };
	// Id format: `<YYYYMMDD>T<HHMMSS>-<rand4hex>[-<label>]`. The label,
	// when present, is the tail after the LAST dash — `endsWith('-' + ref)`
	// matches whatever the user passed as `--label` at save time.
	// Pre-fix used `indexOf('-')` (first dash) which sliced `<rand>-<label>`
	// and never matched against just `<label>` — restore by label always
	// failed.
	const labelMatches = entries.filter((e) => e.id.endsWith(`-${ref}`));
	if (labelMatches.length === 1) return { match: labelMatches[0], ambiguous: false };
	if (labelMatches.length > 1) return { ambiguous: true };
	const prefix = entries.filter((e) => e.id.startsWith(ref));
	if (prefix.length === 1) return { match: prefix[0], ambiguous: false };
	if (prefix.length > 1) return { ambiguous: true };
	return { ambiguous: false };
};

// Label-filter enumerate of containers for THIS (app, stack) — INCLUDING
// stopped ones (`-a`). Both labels are required: filtering on stack
// alone would clobber sibling apps' containers when multiple examples
// in the same monorepo use the default `stack=main` (same mistake the
// pre-Phase-2 `wipe` command had — see `cli/commands/wipe.ts` for the
// canonical pattern).
//
// After `devstack apply` exits, the `docker stop` finalizer Phase 2.3
// registered leaves the containers stopped but still on disk with a
// complete writable layer; `docker commit` works against either state,
// so the snapshot pipeline picks up both running (Ctrl-C-during-`up`
// save) and stopped (`apply` + `save`) containers. Returns `{ id, name }`
// tuples — `id` is the full container id for `docker commit`, `name`
// is the docker --name (`<app>-sui-localnet`, `<app>-sui-indexer-db`,
// `<app>-walrus-<n>-node-0`, …) which we use to build the snapshot's
// per-container tar filename. Failures (daemon down, permission denied)
// surface as an empty list rather than aborting; the engine `snapshot()`
// then captures state-only and the user sees no containers section in
// the resulting meta.json.
const listContainersForAppStack = (
	spawner: ReturnType<typeof ChildProcessSpawner.make>,
	app: string,
	stack: string,
): Effect.Effect<ReadonlyArray<{ id: string; name: string }>> =>
	Effect.gen(function* () {
		const cmd = ChildProcess.make('docker', [
			'ps',
			'-a',
			'--filter',
			`label=${DockerLabel.APP}=${app}`,
			'--filter',
			`label=${DockerLabel.STACK}=${stack}`,
			'--format',
			'{{.ID}}\t{{.Names}}',
		]);
		const text = yield* spawner.string(cmd).pipe(Effect.orElseSucceed(() => ''));
		const out: Array<{ id: string; name: string }> = [];
		for (const line of text.split('\n')) {
			const trimmed = line.trim();
			if (trimmed.length === 0) continue;
			const tab = trimmed.indexOf('\t');
			if (tab === -1) continue;
			const id = trimmed.slice(0, tab);
			const name = trimmed.slice(tab + 1);
			if (id.length > 0 && name.length > 0) out.push({ id, name });
		}
		return out;
	});

const stackFlag = Flag.string('stack').pipe(
	Flag.withDescription('Stack to snapshot (default: active stack, or "main")'),
	Flag.optional,
);

// Mirrors `cli/commands/wipe.ts`'s `--app` flag — both default to the
// app name derived from the working dir's `package.json#name`. Required
// for the `(app, stack)` label filter that scopes container enumeration
// to THIS app's containers, not sibling apps that share `stack=main`.
const appFlag = Flag.string('app').pipe(
	Flag.withDescription(
		"App identifier for container scoping (default: <appDir>/package.json#name's basename, matching `defineDevstack`)",
	),
	Flag.optional,
);

const resolveAppName = (override: Option.Option<string>): string =>
	Option.getOrElse(override, () => deriveAppName(process.env.DEVSTACK_APP_DIR ?? process.cwd()));

const saveCommand = Command.make(
	'save',
	{
		label: Flag.string('label').pipe(Flag.optional),
		stack: stackFlag,
		app: appFlag,
		includeImages: Flag.boolean('include-images').pipe(
			Flag.withDescription(
				'Include `docker commit + save` of running containers (default true). ' +
					'Pass `--no-include-images` for a state-only snapshot — smaller artifact ' +
					'at the cost of needing the next `up` to rebuild chain state from genesis.',
			),
			Flag.withDefault(true),
		),
	},
	({ label, stack, app, includeImages }) =>
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;
			const path = yield* Path.Path;
			const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
			const resolvedStack = yield* resolveStack(fs, path, stack);
			const resolvedApp = resolveAppName(app);
			const id = makeId(label);
			const dir = defaultSnapshotsDir();
			const containers = includeImages
				? yield* listContainersForAppStack(spawner, resolvedApp, resolvedStack)
				: [];
			yield* Console.log(
				`saving snapshot ${id} (app=${resolvedApp}, stack=${resolvedStack}, ${containers.length} container${containers.length === 1 ? '' : 's'})`,
			);
			const result = yield* snapshot({
				id,
				dir,
				app: resolvedApp,
				stack: resolvedStack,
				containers,
			});
			yield* Console.log(`saved snapshot ${id}`);
			yield* Console.log(`  → ${result.path}`);
			if (result.runtimeTar !== undefined) {
				yield* Console.log(`  runtime: ${result.runtimeTar}`);
			}
			if (result.containerTars.length > 0) {
				yield* Console.log(`  containers: ${result.containerTars.length} tar(s)`);
			}
			if (result.extrasTars.length > 0) {
				yield* Console.log(`  extras: ${result.extrasTars.length} tar(s)`);
			}
		}),
).pipe(
	Command.withDescription(
		'Capture state.json + runtime/ + container images into a snapshot for the active stack',
	),
);

const restoreCommand = Command.make(
	'restore',
	{
		ref: Argument.string('id-or-label').pipe(Argument.optional),
		stack: stackFlag,
	},
	({ ref, stack }) =>
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;
			const path = yield* Path.Path;
			const dir = defaultSnapshotsDir();
			const entries = yield* listSnapshots({ dir });
			if (entries.length === 0) {
				return yield* failAlreadyReported(`no snapshots in ${dir}`);
			}

			// Default: newest entry (entries are sorted ascending by
			// createdAt; pick the last one).
			const target = Option.match(ref, {
				onNone: () => ({ match: entries[entries.length - 1], ambiguous: false }) as const,
				onSome: (r) => findMatch(entries, r),
			});

			if (target.ambiguous) {
				return yield* failAlreadyReported(
					`snapshot reference is ambiguous; pass the full id (use \`devstack snapshot list\`)`,
				);
			}
			if (target.match === undefined) {
				return yield* failAlreadyReported(
					`no snapshot matching '${Option.getOrElse(ref, () => '')}'`,
				);
			}

			// Resolve target stack: explicit `--stack` > meta-recorded
			// stack > active-stack > 'main'. Restoring a snapshot saved
			// for stack A into stack B is intentionally allowed (operator
			// might want to clone a known-good world into a fresh stack)
			// but emits a warning.
			const resolvedStack = yield* resolveStack(fs, path, stack);
			const metaStack = target.match.stack;
			if (metaStack !== undefined && metaStack !== resolvedStack) {
				yield* Console.error(
					`warning: snapshot was saved for stack '${metaStack}' but restoring into '${resolvedStack}'`,
				);
			}
			const result = yield* restore({
				id: target.match.id,
				dir,
				stack: resolvedStack,
			});
			yield* Console.log(`restored snapshot ${target.match.id} into stack '${resolvedStack}'`);
			if (result.runtimeRestored) {
				yield* Console.log(`  runtime/ extracted`);
			}
			if (result.loadedImages.length > 0) {
				yield* Console.log(`  loaded images: ${result.loadedImages.join(', ')}`);
			}
			if (result.extrasRestored.length > 0) {
				yield* Console.log(`  extras restored: ${result.extrasRestored.join(', ')}`);
			}
		}),
).pipe(Command.withDescription('Restore state.json + runtime/ + container images from a snapshot'));

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
			const meta =
				entry.stack !== undefined
					? `  [stack=${entry.stack}${entry.network !== undefined ? `, network=${entry.network}` : ''}]`
					: '';
			yield* Console.log(`  ${entry.id}  (${when})${meta}`);
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
				return yield* failAlreadyReported(
					`snapshot reference '${ref}' is ambiguous; pass the full id`,
				);
			}
			if (target.match === undefined) {
				return yield* failAlreadyReported(`no snapshot matching '${ref}'`);
			}
			const targetDir = path.join(snapshotsDir, target.match.id);
			yield* fs
				.remove(targetDir, { recursive: true, force: true })
				.pipe(Effect.mapError((cause) => wrapCause(`failed to remove ${targetDir}`, cause)));
			yield* Console.log(`deleted snapshot ${target.match.id}`);
		}),
).pipe(Command.withDescription('Delete a snapshot directory'));

export const snapshotCommand = Command.make('snapshot').pipe(
	Command.withDescription(
		'Capture / restore labeled snapshots of state.json + runtime/ + container images',
	),
	Command.withSubcommands([saveCommand, restoreCommand, listCommand, deleteCommand]),
);
