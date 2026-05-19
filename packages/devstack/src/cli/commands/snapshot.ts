// `devstack snapshot <save|restore|list|delete>` — wraps
// `internal/snapshot.ts` with a thin CLI surface.
//
// Save flow:
//   1. Resolve active stack via `.devstack/active` (or `--stack <name>`).
//   2. Enumerate containers labelled `devstack.stack=<stack>` via
//      `docker ps`. Their `{id, name}` tuples feed into the engine
//      `snapshot()` which `docker commit + save`s each into the
//      snapshot dir.
//   3. The engine also tars the canonical `runtime/<service>/...` dir
//      and any opt-in extras passed to `saveSnapshot({ extras })`.
//   4. `state.json` is copied verbatim.
//
// Snapshot ids are timestamp-based (UTC, second resolution); an
// optional `--label` is appended via a hyphen to disambiguate ids
// saved within the same second. `restore` accepts either the raw id
// or a prefix / label.

/* eslint-disable @typescript-eslint/no-explicit-any */

import { promises as nodeFs } from 'node:fs';
import { join as joinPath } from 'node:path';
import { Console, Effect, FileSystem, Option, Path } from 'effect';
import { Argument, Command, Flag } from 'effect/unstable/cli';
import { ChildProcess, ChildProcessSpawner } from 'effect/unstable/process';
import { randomBytes } from 'node:crypto';
import { wrapCause } from '../loaders.js';
import { promptConfirm } from '../cli-prompt.js';
import {
	emitEnvelope,
	failWithEnvelope,
	jsonModeEnabled,
	successEnvelope,
} from '../envelope.js';
import { EX_SNAPSHOT_NOT_FOUND, EX_USAGE, EX_CONFIRM_REQUIRED } from '../exit-codes.js';
import {
	resolveAppName,
	resolveForkDataDir,
	resolveStack,
	stateDir,
} from '../stack-resolution.js';
import { DockerLabel } from '../../engine/identity.js';
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
// in the same monorepo use the default `stack=main` (see
// `cli/commands/wipe.ts` for the canonical pattern).
//
// After `devstack apply` exits, the `docker stop` finalizer in
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

// Threshold above which `--include-fork-data` flips OFF by default.
// 1GB is the canonical break-even — below it, capturing the fork data
// is essentially free (snapshot is tar-compressed and
// `docker commit` already captures the writable layer where chain
// state lives). Above it, the snapshot artifact balloons faster than
// the rebuild cost saved, so we opt out by default with a printed hint.
const FORK_DATA_DEFAULT_INCLUDE_THRESHOLD = 1 * 1024 * 1024 * 1024;

const safeDirSize = async (root: string): Promise<number> => {
	try {
		const stat = await nodeFs.stat(root);
		if (stat.isDirectory()) {
			let total = 0;
			const entries = await nodeFs.readdir(root);
			for (const entry of entries) {
				total += await safeDirSize(joinPath(root, entry));
			}
			return total;
		}
		return stat.size;
	} catch {
		return 0;
	}
};

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
		// Gate the per-stack `sui-fork/data/` capture. Three-state:
		// explicit on (`--include-fork-data`), explicit off
		// (`--no-include-fork-data`), or auto-by-threshold (default,
		// `--include-fork-data` flips false above 1GB with a printed
		// hint). Mirrors `--include-images`'s default-on / opt-out shape.
		includeForkData: Flag.boolean('include-fork-data').pipe(
			Flag.withDescription(
				'Include `.devstack/stacks/<stack>/sui-fork/data/` in the snapshot as an extras tar. ' +
					'Default: auto — include when the data dir is under ' +
					`${Math.round(FORK_DATA_DEFAULT_INCLUDE_THRESHOLD / (1024 * 1024 * 1024))}GB, exclude above (with a printed hint).`,
			),
			Flag.optional,
		),
		json: Flag.boolean('json').pipe(
			Flag.withDescription('Emit a machine-readable envelope to stdout'),
			Flag.withDefault(false),
		),
		dryRun: Flag.boolean('dry-run').pipe(
			Flag.withDescription('Resolve the plan and exit without writing the snapshot'),
			Flag.withDefault(false),
		),
	},
	({ label, stack, app, includeImages, includeForkData, json, dryRun }) =>
		Effect.gen(function* () {
			const startedAt = Date.now();
			const useJson = jsonModeEnabled(json);
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

			// Resolve the optional fork-data extras entry. The fork data
			// dir only exists for fork-mode stacks (created by `buildFork`
			// during apply); a missing directory means "not a fork stack"
			// and we silently skip without warning. Above-threshold,
			// auto-mode flips to false with a printed hint so the user
			// knows the data was excluded.
			const forkDataDir = resolveForkDataDir({ stack: resolvedStack });
			const forkDataBytes = yield* Effect.promise(() => safeDirSize(forkDataDir));
			const extras: Array<{ key: string; path: string }> = [];
			let includeForkDataResolved = Option.getOrUndefined(includeForkData);
			if (forkDataBytes === 0) {
				// No fork data on disk (not a fork stack OR fresh first-
				// boot pre-meta). Treat as a no-op regardless of the
				// flag's setting.
				includeForkDataResolved = false;
			} else if (includeForkDataResolved === undefined) {
				includeForkDataResolved = forkDataBytes < FORK_DATA_DEFAULT_INCLUDE_THRESHOLD;
				if (!includeForkDataResolved) {
					yield* Console.log(
						`note: fork data dir ${forkDataDir} is ${Math.round(forkDataBytes / (1024 * 1024))} MiB — ` +
							`above the ${Math.round(FORK_DATA_DEFAULT_INCLUDE_THRESHOLD / (1024 * 1024 * 1024))} GB auto-include threshold; ` +
							`pass --include-fork-data to capture it anyway.`,
					);
				}
			}
			if (includeForkDataResolved) {
				extras.push({ key: 'sui-fork-data', path: forkDataDir });
			}

			if (dryRun) {
				const data = {
					id,
					path: joinPath(dir, id),
					app: resolvedApp,
					stack: resolvedStack,
					wouldCapture: {
						containers: containers.map((c) => c.name),
						extras: extras.map((e) => e.key),
						includeImages,
						includeForkData: includeForkDataResolved === true,
					},
				};
				if (useJson) {
					yield* emitEnvelope(
						successEnvelope({
							command: 'snapshot.save',
							data,
							elapsedMs: Date.now() - startedAt,
							dryRun: true,
						}),
					);
				} else {
					yield* Console.log(
						`would save snapshot ${id} (app=${resolvedApp}, stack=${resolvedStack}, ${containers.length} container${containers.length === 1 ? '' : 's'}, ${extras.length} extra${extras.length === 1 ? '' : 's'}) — dry run`,
					);
				}
				return;
			}

			if (!useJson) {
				yield* Console.log(
					`saving snapshot ${id} (app=${resolvedApp}, stack=${resolvedStack}, ${containers.length} container${containers.length === 1 ? '' : 's'})`,
				);
			}
			const result = yield* snapshot({
				id,
				dir,
				app: resolvedApp,
				stack: resolvedStack,
				containers,
				...(extras.length > 0 ? { extras } : {}),
			});
			if (useJson) {
				yield* emitEnvelope(
					successEnvelope({
						command: 'snapshot.save',
						data: {
							id,
							path: result.path,
							app: resolvedApp,
							stack: resolvedStack,
							runtimeTar: result.runtimeTar,
							containerTars: result.containerTars.length,
							extrasTars: result.extrasTars.length,
						},
						elapsedMs: Date.now() - startedAt,
					}),
				);
				return;
			}
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
		json: Flag.boolean('json').pipe(
			Flag.withDescription('Emit a machine-readable envelope to stdout'),
			Flag.withDefault(false),
		),
		dryRun: Flag.boolean('dry-run').pipe(
			Flag.withDescription('Resolve the target snapshot and exit without mutating disk'),
			Flag.withDefault(false),
		),
	},
	({ ref, stack, json, dryRun }) =>
		Effect.gen(function* () {
			const startedAt = Date.now();
			const useJson = jsonModeEnabled(json);
			const fs = yield* FileSystem.FileSystem;
			const path = yield* Path.Path;
			const dir = defaultSnapshotsDir();
			const entries = yield* listSnapshots({ dir });
			if (entries.length === 0) {
				return yield* failWithEnvelope({
					command: 'snapshot.restore',
					error: {
						code: 'SNAPSHOT_NOT_FOUND',
						exitCode: EX_SNAPSHOT_NOT_FOUND,
						message: `no snapshots in ${dir}`,
					},
					elapsedMs: Date.now() - startedAt,
					json: useJson,
				});
			}

			// Default: newest entry (entries are sorted ascending by
			// createdAt; pick the last one).
			const target = Option.match(ref, {
				onNone: () => ({ match: entries[entries.length - 1], ambiguous: false }) as const,
				onSome: (r) => findMatch(entries, r),
			});

			if (target.ambiguous) {
				return yield* failWithEnvelope({
					command: 'snapshot.restore',
					error: {
						code: 'AMBIGUOUS_REF',
						exitCode: EX_USAGE,
						message:
							'snapshot reference is ambiguous; pass the full id (use `devstack snapshot list`)',
						hint: 'devstack snapshot list',
					},
					elapsedMs: Date.now() - startedAt,
					json: useJson,
				});
			}
			if (target.match === undefined) {
				return yield* failWithEnvelope({
					command: 'snapshot.restore',
					error: {
						code: 'SNAPSHOT_NOT_FOUND',
						exitCode: EX_SNAPSHOT_NOT_FOUND,
						message: `no snapshot matching '${Option.getOrElse(ref, () => '')}'`,
					},
					elapsedMs: Date.now() - startedAt,
					json: useJson,
				});
			}

			// Resolve target stack: explicit `--stack` > meta-recorded
			// stack > active-stack > 'main'. Restoring a snapshot saved
			// for stack A into stack B is intentionally allowed (operator
			// might want to clone a known-good world into a fresh stack)
			// but emits a warning.
			const resolvedStack = yield* resolveStack(fs, path, stack);
			const metaStack = target.match.stack;
			if (dryRun) {
				const data = {
					id: target.match.id,
					path: joinPath(dir, target.match.id),
					targetStack: resolvedStack,
					...(metaStack !== undefined ? { savedForStack: metaStack } : {}),
					crossStack: metaStack !== undefined && metaStack !== resolvedStack,
				};
				if (useJson) {
					yield* emitEnvelope(
						successEnvelope({
							command: 'snapshot.restore',
							data,
							elapsedMs: Date.now() - startedAt,
							dryRun: true,
						}),
					);
				} else {
					yield* Console.log(
						`would restore snapshot ${target.match.id} into stack '${resolvedStack}'${data.crossStack ? ` (cross-stack from '${metaStack}')` : ''} — dry run`,
					);
				}
				return;
			}
			if (metaStack !== undefined && metaStack !== resolvedStack && !useJson) {
				yield* Console.error(
					`warning: snapshot was saved for stack '${metaStack}' but restoring into '${resolvedStack}'`,
				);
			}
			const result = yield* restore({
				id: target.match.id,
				dir,
				stack: resolvedStack,
			});
			if (useJson) {
				yield* emitEnvelope(
					successEnvelope({
						command: 'snapshot.restore',
						data: {
							id: target.match.id,
							targetStack: resolvedStack,
							runtimeRestored: result.runtimeRestored,
							loadedImages: result.loadedImages,
							extrasRestored: result.extrasRestored,
						},
						elapsedMs: Date.now() - startedAt,
					}),
				);
				return;
			}
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

const listCommand = Command.make(
	'list',
	{
		json: Flag.boolean('json').pipe(
			Flag.withDescription('Emit a machine-readable envelope to stdout'),
			Flag.withDefault(false),
		),
	},
	({ json }) =>
		Effect.gen(function* () {
			const startedAt = Date.now();
			const useJson = jsonModeEnabled(json);
			const dir = defaultSnapshotsDir();
			const entries = yield* listSnapshots({ dir });
			if (useJson) {
				yield* emitEnvelope(
					successEnvelope({
						command: 'snapshot.list',
						data: {
							dir,
							entries: entries.map((e) => ({
								id: e.id,
								createdAt: e.createdAt,
								stack: e.stack,
								network: e.network,
							})),
						},
						elapsedMs: Date.now() - startedAt,
					}),
				);
				return;
			}
			if (entries.length === 0) {
				yield* Console.log(`no snapshots in ${dir}`);
				return;
			}
			yield* Console.log(`snapshots in ${dir}:`);
			// List newest-first — `git log`-style chronology.
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
		yes: Flag.boolean('yes').pipe(
			Flag.withDescription('Bypass the confirmation prompt (CI / non-interactive)'),
			Flag.withDefault(false),
		),
		json: Flag.boolean('json').pipe(
			Flag.withDescription('Emit a machine-readable envelope to stdout'),
			Flag.withDefault(false),
		),
		dryRun: Flag.boolean('dry-run').pipe(
			Flag.withDescription('Resolve the target snapshot and exit without removing it'),
			Flag.withDefault(false),
		),
		noInput: Flag.boolean('no-input').pipe(
			Flag.withDescription('Fail rather than prompt (CI / piped stdin)'),
			Flag.withDefault(false),
		),
	},
	({ ref, yes, json, dryRun, noInput }) =>
		Effect.gen(function* () {
			const startedAt = Date.now();
			const useJson = jsonModeEnabled(json);
			const fs = yield* FileSystem.FileSystem;
			const path = yield* Path.Path;
			const snapshotsDir = defaultSnapshotsDir();
			const entries = yield* listSnapshots({ dir: snapshotsDir });
			const target = findMatch(entries, ref);
			if (target.ambiguous) {
				return yield* failWithEnvelope({
					command: 'snapshot.delete',
					error: {
						code: 'AMBIGUOUS_REF',
						exitCode: EX_USAGE,
						message: `snapshot reference '${ref}' is ambiguous; pass the full id`,
						hint: 'devstack snapshot list',
					},
					elapsedMs: Date.now() - startedAt,
					json: useJson,
				});
			}
			if (target.match === undefined) {
				return yield* failWithEnvelope({
					command: 'snapshot.delete',
					error: {
						code: 'SNAPSHOT_NOT_FOUND',
						exitCode: EX_SNAPSHOT_NOT_FOUND,
						message: `no snapshot matching '${ref}'`,
					},
					elapsedMs: Date.now() - startedAt,
					json: useJson,
				});
			}
			const targetDir = path.join(snapshotsDir, target.match.id);

			if (dryRun) {
				if (useJson) {
					yield* emitEnvelope(
						successEnvelope({
							command: 'snapshot.delete',
							data: {
								wouldDelete: {
									id: target.match.id,
									path: targetDir,
								},
							},
							elapsedMs: Date.now() - startedAt,
							dryRun: true,
						}),
					);
				} else {
					yield* Console.log(`would delete snapshot ${target.match.id} (${targetDir}) — dry run`);
				}
				return;
			}

			const outcome = yield* promptConfirm({
				message: `Delete snapshot '${target.match.id}'?`,
				preview: [`id:   ${target.match.id}`, `path: ${targetDir}`],
				yes,
				noInput,
			});
			if (outcome.kind === 'non-interactive') {
				return yield* failWithEnvelope({
					command: 'snapshot.delete',
					error: {
						code:
							outcome.exitCode === EX_CONFIRM_REQUIRED ? 'CONFIRM_REQUIRED' : 'CONFIRM_UNSUPPORTED',
						exitCode: outcome.exitCode,
						message: `devstack snapshot delete: ${outcome.reason}. Pass --yes to bypass.`,
						hint: `devstack snapshot delete ${ref} --yes`,
					},
					elapsedMs: Date.now() - startedAt,
					json: useJson,
				});
			}
			if (outcome.kind === 'cancelled' || outcome.kind === 'declined') {
				return yield* failWithEnvelope({
					command: 'snapshot.delete',
					error: {
						code: outcome.kind === 'cancelled' ? 'CANCELLED' : 'DECLINED',
						exitCode: EX_USAGE,
						message: `devstack snapshot delete: ${outcome.kind} by operator`,
					},
					elapsedMs: Date.now() - startedAt,
					json: useJson,
					humanFallback: Console.log(
						`devstack snapshot delete: ${outcome.kind} by operator — no changes made`,
					),
				});
			}

			yield* fs
				.remove(targetDir, { recursive: true, force: true })
				.pipe(Effect.mapError((cause) => wrapCause(`failed to remove ${targetDir}`, cause)));
			if (useJson) {
				yield* emitEnvelope(
					successEnvelope({
						command: 'snapshot.delete',
						data: { id: target.match.id, path: targetDir },
						elapsedMs: Date.now() - startedAt,
					}),
				);
				return;
			}
			yield* Console.log(`deleted snapshot ${target.match.id}`);
		}),
).pipe(Command.withDescription('Delete a snapshot directory'));

export const snapshotCommand = Command.make('snapshot').pipe(
	Command.withDescription(
		'Capture / restore labeled snapshots of state.json + runtime/ + container images',
	),
	Command.withSubcommands([saveCommand, restoreCommand, listCommand, deleteCommand]),
);
