// `devstack prune` — cross-stack cleanup surface.
//
// Where `devstack wipe` targets one (app, stack) inferred from the
// caller's cwd, `prune` is the way out of "I have docker volumes from
// six apps I'd already forgotten about". Three modes:
//
//   --list                          Print the same inventory as
//                                   `doctor`'s Inventory section but
//                                   without the preflight checks. Safe
//                                   in scripts.
//   --interactive (default)         Ink-based picker. Toggle stacks,
//                                   confirm, then prune. Refuses to run
//                                   on a non-TTY stdin so CI doesn't
//                                   hang waiting for keys.
//   --all-orphans --yes             Remove every (app, stack) whose
//                                   supervisor isn't currently running.
//   <app>/<stack> --yes             Remove one specific bucket. Lets
//                                   you target a stack from another app
//                                   without `cd`-ing into its repo.
//
// All four modes share `_prune-stack.pruneStack` for the actual
// teardown: containers, networks, volumes, state dir.
//
// A live supervisor lock is the single hard "no": we look up each
// stack's `state.json.lock`, `kill(pid, 0)` for liveness, and skip the
// row with `skipped: <app>/<stack> (running pid <N>)` on the way past.

import { existsSync, promises as nodeFs } from 'node:fs';
import { Console, Effect, Option } from 'effect';
import { Argument, Command, Flag } from 'effect/unstable/cli';
import { ChildProcess, ChildProcessSpawner } from 'effect/unstable/process';
import { render } from 'ink';
import React from 'react';
import {
	collectInventory,
	collectRouterInfo,
	formatBytes,
	isPidAlive,
	renderInventoryRow,
	renderRouterRow,
	renderTotals,
	totalsFor,
	type InventoryRow,
} from '../../engine/docker/inventory.js';
import { ROUTER_CONTAINER, ROUTER_NETWORK } from '../../engine/docker/router.js';
import { Registry } from '../../engine/registry.js';
import { AlreadyReportedError, failAlreadyReported } from '../already-reported.js';
import { resolveForkCacheRoot } from '../stack-resolution.js';
import { pruneStack, removeLabelledImagesNotInUse, type PruneStackResult } from './_prune-stack.js';
import { PruneApp } from './_prune-ui.js';

const TARGET_RE = /^([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)$/;

const targetArg = Argument.string('target').pipe(
	Argument.withDescription("'<app>/<stack>' — non-interactive single-stack prune"),
	Argument.optional,
);

const yesFlag = Flag.boolean('yes').pipe(
	Flag.withDescription('Required for any mutating mode (target argument or --all-orphans)'),
	Flag.withDefault(false),
);

const listFlag = Flag.boolean('list').pipe(
	Flag.withDescription('Print the inventory and exit (no mutation, scriptable)'),
	Flag.withDefault(false),
);

const allOrphansFlag = Flag.boolean('all-orphans').pipe(
	Flag.withDescription(
		'Remove every stack whose supervisor is not running (use with care; requires --yes)',
	),
	Flag.withDefault(false),
);

const interactiveFlag = Flag.boolean('interactive').pipe(
	Flag.withDescription('Force the Ink picker even if other flags would imply non-interactive'),
	Flag.withDefault(false),
);

const keepSnapshotsFlag = Flag.boolean('keep-snapshots').pipe(
	Flag.withDescription("Don't delete labeled snapshots under snapshots/"),
	Flag.withDefault(false),
);

const imagesFlag = Flag.boolean('images').pipe(
	Flag.withDescription('Also `docker rmi` devstack-* images with no running containers'),
	Flag.withDefault(false),
);

const includeImagesFlag = Flag.boolean('include-images').pipe(
	Flag.withDescription(
		'Also remove every image carrying the devstack.image=true label that no running container uses',
	),
	Flag.withDefault(false),
);

const repoGoneFlag = Flag.boolean('repo-gone').pipe(
	Flag.withDescription('Remove every stack whose recorded repoPath no longer exists on disk'),
	Flag.withDefault(false),
);

const appFilterFlag = Flag.string('app').pipe(
	Flag.withDescription(
		'Filter all modes (list / interactive / --repo-gone / --all-orphans) by app name',
	),
	Flag.optional,
);

const dryRunFlag = Flag.boolean('dry-run').pipe(
	Flag.withDescription('Print what would happen without removing anything'),
	Flag.withDefault(false),
);

const includeRouterFlag = Flag.boolean('include-router').pipe(
	Flag.withDescription(
		'Also stop + remove the shared Traefik router container and its network (devstack-traefik / devstack-router)',
	),
	Flag.withDefault(false),
);

// Global cleanup of `.devstack/sui-fork-cache/<chainId>/`
// directories whose chainId is no longer referenced by any active fork
// stack. Distinct from `wipe --also-upstream-cache` (which clears the
// cache wholesale for ONE stack's wipe); this scans referenced chain
// ids across every fork stack on the machine and only removes orphans.
const includeForkCacheFlag = Flag.boolean('include-fork-cache').pipe(
	Flag.withDescription(
		'Also remove orphaned entries under `.devstack/sui-fork-cache/` whose chainId is not ' +
			'referenced by any active fork-mode stack',
	),
	Flag.withDefault(false),
);

// Decide which mode to run based on the flag combination. The decision
// is exhaustive so a stray combination (e.g. `--list --all-orphans`)
// resolves to a single mode rather than silently picking one over the
// other.
//
// Priority order — narrowest filter wins so a user that types
// `prune --repo-gone --list` still gets list (read-only beats write).
// `--list` > target arg > `--repo-gone` > `--all-orphans` > default
// interactive.
type Mode =
	| { readonly kind: 'list' }
	| { readonly kind: 'target'; readonly app: string; readonly stack: string }
	| { readonly kind: 'repo-gone' }
	| { readonly kind: 'all-orphans' }
	| { readonly kind: 'interactive' };

const resolveMode = (input: {
	readonly list: boolean;
	readonly target: Option.Option<string>;
	readonly repoGone: boolean;
	readonly allOrphans: boolean;
	readonly interactive: boolean;
}): Effect.Effect<Mode, AlreadyReportedError> =>
	Effect.gen(function* () {
		if (input.list) return { kind: 'list' } as const;
		if (Option.isSome(input.target)) {
			const m = TARGET_RE.exec(input.target.value);
			if (m === null) {
				return yield* failAlreadyReported(
					`prune: target '${input.target.value}' must be '<app>/<stack>' (e.g. 'arena/main')`,
				);
			}
			const [, app, stack] = m as unknown as [string, string, string];
			return { kind: 'target', app, stack } as const;
		}
		if (input.repoGone) return { kind: 'repo-gone' } as const;
		if (input.allOrphans) return { kind: 'all-orphans' } as const;
		return { kind: 'interactive' } as const;
	});

// Silent GC of stale registry entries: any entry whose `repoPath` is
// still on disk but has no surviving docker resources is a leftover
// from a `wipe` that didn't clean the registry, or out-of-band
// cleanup. Drop it from the registry on every mutating prune run so the
// inventory doesn't keep nagging the user. The collectInventory
// snapshot has already filtered these out of `rows`, so we re-derive
// the candidates here from the registry directly.
const gcStaleRegistryEntries = (rows: ReadonlyArray<InventoryRow>) =>
	Effect.gen(function* () {
		const registry = yield* Registry;
		const reg = yield* registry.read;
		const presentKeys = new Set(rows.map((r) => `${r.app}/${r.stack}`));
		for (const entry of reg.stacks) {
			const key = `${entry.app}/${entry.stack}`;
			if (presentKeys.has(key)) continue;
			if (entry.pid !== undefined && isPidAlive(entry.pid)) continue;
			if (!existsSync(entry.repoPath)) continue;
			yield* registry.remove(entry.app, entry.stack, entry.network).pipe(Effect.ignore);
		}
	});

const renderPruneResult = (app: string, stack: string, result: PruneStackResult): string => {
	const killed = result.killedContainers.length;
	const networks = result.removedNetworks.length;
	const volumes = result.removedVolumes.length;
	const state = result.removedStatePaths.length;
	return `pruned ${app}/${stack}: ${killed} container${killed === 1 ? '' : 's'}, ${networks} network${networks === 1 ? '' : 's'}, ${volumes} volume${volumes === 1 ? '' : 's'}, ${state} state ${state === 1 ? 'path' : 'paths'}`;
};

// Live-supervisor refusal point. Mirrors the `state.json.lock`
// liveness check the inventory does — re-runs it here in case the
// inventory snapshot is stale by the time the user confirms.
const findRunningRow = (
	rows: ReadonlyArray<InventoryRow>,
	app: string,
	stack: string,
): InventoryRow | undefined => {
	const match = rows.find((r) => r.app === app && r.stack === stack);
	if (match === undefined) return undefined;
	if (match.runningPid === undefined) return undefined;
	if (!isPidAlive(match.runningPid)) return undefined;
	return match;
};

const pruneRows = (
	rows: ReadonlyArray<InventoryRow>,
	options: {
		readonly keepSnapshots: boolean;
		readonly images: boolean;
		readonly dryRun: boolean;
	},
) =>
	Effect.gen(function* () {
		for (const row of rows) {
			const running = findRunningRow(rows, row.app, row.stack);
			if (running !== undefined) {
				yield* Console.log(`skipped: ${row.app}/${row.stack} (running pid ${running.runningPid})`);
				continue;
			}
			if (options.dryRun) {
				const tag = row.classification === 'repo-gone' ? ' (repo gone)' : '';
				yield* Console.log(
					`would prune ${row.app}/${row.stack}${tag}: ${row.containers.length} containers, ${row.networks.length} networks, ${row.volumes.length} volumes`,
				);
				continue;
			}
			const result = yield* pruneStack({
				app: row.app,
				stack: row.stack,
				network: row.registryEntry?.network ?? 'localnet',
				keepSnapshots: options.keepSnapshots,
				removeImages: options.images,
				extraStateDirs: row.stateDirs,
			});
			yield* Console.log(renderPruneResult(row.app, row.stack, result));
		}
	});

// Inventory-print path used by `--list`.
const printInventory = (rows: ReadonlyArray<InventoryRow>) =>
	Effect.gen(function* () {
		// Surface the shared Traefik router on its own line above the
		// (app, stack) listing. The router is cross-stack infrastructure
		// (one container, one network) — not a row in the per-stack
		// bucket. Showing usage (how many backends, how many apps)
		// helps the user decide whether `--include-router` would
		// disrupt active work.
		const router = yield* collectRouterInfo().pipe(Effect.orElseSucceed(() => undefined));
		if (router !== undefined) {
			yield* Console.log(renderRouterRow(router));
		}
		if (rows.length === 0) {
			yield* Console.log('(no devstack-labelled resources)');
			return;
		}
		for (const row of rows) {
			yield* Console.log(renderInventoryRow(row));
		}
		yield* Console.log('');
		yield* Console.log(renderTotals(totalsFor(rows)));
	});

interface BulkModeArgs {
	readonly keepSnapshots: boolean;
	readonly images: boolean;
	readonly includeImages: boolean;
	readonly includeRouter: boolean;
	readonly includeForkCache: boolean;
	readonly dryRun: boolean;
	readonly yes: boolean;
}

// Shared body for `--repo-gone` and `--all-orphans`. Caller pre-filters
// the matching rows; we just gate on --yes / --dry-run, print a tally,
// then delegate to pruneRows. `dryRun` skips the `--yes` requirement
// since printing is read-only.
const runBulkMode = (input: {
	readonly label: string;
	readonly rows: ReadonlyArray<InventoryRow>;
	readonly args: BulkModeArgs;
}) =>
	Effect.gen(function* () {
		if (input.rows.length === 0) {
			yield* Console.log(`prune --${input.label}: nothing matches`);
			return;
		}
		if (!input.args.yes && !input.args.dryRun) {
			return yield* failAlreadyReported(
				`devstack prune --${input.label}: --yes (or --dry-run) is required to remove ${input.rows.length} stack${input.rows.length === 1 ? '' : 's'}`,
			);
		}
		const totals = totalsFor(input.rows);
		yield* Console.log(
			`pruning ${input.rows.length} ${input.label} stack${input.rows.length === 1 ? '' : 's'}${totals.bytes > 0 ? ` (~${formatBytes(totals.bytes)})` : ''}`,
		);
		yield* pruneRows(input.rows, {
			keepSnapshots: input.args.keepSnapshots,
			images: input.args.images,
			dryRun: input.args.dryRun,
		});
		yield* maybePruneImages(input.args.includeImages, input.args.dryRun);
		yield* maybePruneRouter(input.args.includeRouter, input.args.dryRun);
		yield* maybePruneForkCache(input.args.includeForkCache, input.args.dryRun);
	});

// `--include-fork-cache` post-pass. Walks `.devstack/sui-fork-cache/`
// and removes per-chainId directories that no active fork stack
// references. The referenced set is derived from each
// `.devstack/stacks/<stack>/sui-fork/meta.json`'s recorded chainId +
// upstream (the upstream literal doubles as a fallback cache key for
// meta.json files written before chainId was persisted there).
const maybePruneForkCache = (
	enabled: boolean,
	dryRun: boolean,
): Effect.Effect<void, never, never> =>
	Effect.gen(function* () {
		if (!enabled) return;
		const cacheRoot = resolveForkCacheRoot();
		const stateRoot = cacheRoot.replace(/\/sui-fork-cache$/, '');
		const referenced = yield* Effect.promise(async () => {
			const out = new Set<string>();
			try {
				const stacksDir = `${stateRoot}/stacks`;
				const stacks = await nodeFs.readdir(stacksDir);
				for (const stack of stacks) {
					try {
						const meta = await nodeFs.readFile(`${stacksDir}/${stack}/sui-fork/meta.json`, 'utf8');
						const parsed = JSON.parse(meta) as { upstream?: string; chainId?: string };
						if (parsed.chainId !== undefined) out.add(parsed.chainId);
						if (parsed.upstream !== undefined) out.add(parsed.upstream);
					} catch {
						// best-effort
					}
				}
			} catch {
				// no stacks dir; referenced stays empty
			}
			return out;
		});
		const entries = yield* Effect.promise(async () => {
			try {
				return await nodeFs.readdir(cacheRoot);
			} catch {
				return [] as ReadonlyArray<string>;
			}
		});
		const orphans = entries.filter((e) => !referenced.has(e));
		if (orphans.length === 0) {
			yield* Console.log(`fork cache: no orphan entries (kept ${entries.length})`);
			return;
		}
		if (dryRun) {
			for (const o of orphans) {
				yield* Console.log(`would remove fork cache ${cacheRoot}/${o}`);
			}
			return;
		}
		let removed = 0;
		for (const o of orphans) {
			const ok = yield* Effect.promise(async () => {
				try {
					await nodeFs.rm(`${cacheRoot}/${o}`, { recursive: true, force: true });
					return true;
				} catch {
					return false;
				}
			});
			if (ok) removed += 1;
		}
		yield* Console.log(
			`fork cache: removed ${removed} orphan ${removed === 1 ? 'entry' : 'entries'} ` +
				`(kept ${entries.length - removed})`,
		);
	});

// `--include-router` post-pass. Removes the cross-stack singleton
// traefik container + its shared network. Best-effort throughout —
// docker errors don't block other prune steps.
const maybePruneRouter = (enabled: boolean, dryRun: boolean) =>
	Effect.gen(function* () {
		if (!enabled) return;
		if (dryRun) {
			yield* Console.log(
				`would also remove the shared traefik router (${ROUTER_CONTAINER}) and its network (${ROUTER_NETWORK})`,
			);
			return;
		}
		const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
		const rmContainer = yield* spawner
			.exitCode(ChildProcess.make('docker', ['rm', '-f', ROUTER_CONTAINER]))
			.pipe(
				Effect.map(() => true),
				Effect.orElseSucceed(() => false),
			);
		const rmNetwork = yield* spawner
			.exitCode(ChildProcess.make('docker', ['network', 'rm', ROUTER_NETWORK]))
			.pipe(
				Effect.map(() => true),
				Effect.orElseSucceed(() => false),
			);
		yield* Console.log(
			`removed router: container=${rmContainer ? 'yes' : 'no'}, network=${rmNetwork ? 'yes' : 'no'}`,
		);
	});

// `--include-images` post-pass. Distinct from `--images` (which is
// scoped to the per-stack `pruneStack` call): this one walks every
// `devstack.image=true`-labelled image on the host and removes those
// not referenced by any container. Dry-run prints what would happen.
const maybePruneImages = (enabled: boolean, dryRun: boolean) =>
	Effect.gen(function* () {
		if (!enabled) return;
		if (dryRun) {
			yield* Console.log(
				'would also remove every devstack.image=true-labelled image not in use by any container',
			);
			return;
		}
		const removed = yield* removeLabelledImagesNotInUse();
		yield* Console.log(
			`removed ${removed.length} labelled image${removed.length === 1 ? '' : 's'} (devstack.image=true, no live container)`,
		);
	});

// Mount the Ink picker, await the user's choice, then return the
// selected rows. We unmount BEFORE resolving so the calling Effect
// can stream `Console.log` lines without fighting Ink for the TTY.
const runInteractivePicker = (rows: ReadonlyArray<InventoryRow>) =>
	Effect.gen(function* () {
		// Pull the router info BEFORE mounting Ink so the row appears
		// in the first frame. Best-effort: a failing docker query just
		// elides the row.
		const router = yield* collectRouterInfo().pipe(Effect.orElseSucceed(() => undefined));
		return yield* Effect.callback<ReadonlyArray<InventoryRow>>((resume) => {
			const instance = render(
				React.createElement(PruneApp, {
					rows,
					router,
					onSubmit: (selected: ReadonlyArray<InventoryRow>) => {
						instance.unmount();
						resume(Effect.succeed(selected));
					},
					onQuit: () => {
						instance.unmount();
						resume(Effect.succeed([] as ReadonlyArray<InventoryRow>));
					},
				}),
				// Picker doesn't need patchConsole — we only `Console.log` the
				// result lines AFTER unmount.
				{ exitOnCtrlC: false },
			);
		});
	});

export const pruneCommand = Command.make(
	'prune',
	{
		target: targetArg,
		yes: yesFlag,
		list: listFlag,
		allOrphans: allOrphansFlag,
		interactive: interactiveFlag,
		keepSnapshots: keepSnapshotsFlag,
		images: imagesFlag,
		includeImages: includeImagesFlag,
		repoGone: repoGoneFlag,
		appFilter: appFilterFlag,
		dryRun: dryRunFlag,
		includeRouter: includeRouterFlag,
		includeForkCache: includeForkCacheFlag,
	},
	(args) =>
		Effect.gen(function* () {
			const mode = yield* resolveMode({
				list: args.list,
				target: args.target,
				repoGone: args.repoGone,
				allOrphans: args.allOrphans,
				interactive: args.interactive,
			});

			const allRows = yield* collectInventory();
			// `--app <name>` narrows every non-target mode. Target mode
			// already names a specific (app, stack), so the filter is a
			// no-op there.
			const appFilter = Option.getOrUndefined(args.appFilter);
			const rows = appFilter !== undefined ? allRows.filter((r) => r.app === appFilter) : allRows;

			if (mode.kind === 'list') {
				yield* printInventory(rows);
				return;
			}

			// All mutating modes silently GC stale registry entries
			// (repo still on disk but no docker resources). Skipped on
			// dry-run so a `--dry-run` pass doesn't surprise the user
			// with a registry write.
			if (!args.dryRun) {
				yield* gcStaleRegistryEntries(allRows);
			}

			if (mode.kind === 'target') {
				if (!args.yes && !args.dryRun) {
					return yield* failAlreadyReported(
						`devstack prune: --yes (or --dry-run) is required to prune ${mode.app}/${mode.stack}`,
					);
				}
				const running = findRunningRow(allRows, mode.app, mode.stack);
				if (running !== undefined) {
					return yield* failAlreadyReported(
						`prune: refusing to remove ${mode.app}/${mode.stack} — supervisor is running (pid ${running.runningPid}). Stop it first.`,
					);
				}
				const matchingInventory = allRows.find((r) => r.app === mode.app && r.stack === mode.stack);
				if (args.dryRun) {
					const m = matchingInventory;
					const tag = m?.classification === 'repo-gone' ? ' (repo gone)' : '';
					yield* Console.log(
						`would prune ${mode.app}/${mode.stack}${tag}: ${m?.containers.length ?? 0} containers, ${m?.networks.length ?? 0} networks, ${m?.volumes.length ?? 0} volumes`,
					);
					return;
				}
				const result = yield* pruneStack({
					app: mode.app,
					stack: mode.stack,
					network: matchingInventory?.registryEntry?.network ?? 'localnet',
					keepSnapshots: args.keepSnapshots,
					removeImages: args.images,
					extraStateDirs: matchingInventory !== undefined ? matchingInventory.stateDirs : undefined,
				});
				yield* Console.log(renderPruneResult(mode.app, mode.stack, result));
				yield* maybePruneImages(args.includeImages, args.dryRun);
				yield* maybePruneRouter(args.includeRouter, args.dryRun);
				yield* maybePruneForkCache(args.includeForkCache, args.dryRun);
				return;
			}

			if (mode.kind === 'repo-gone') {
				const matched = rows.filter((r) => r.classification === 'repo-gone');
				yield* runBulkMode({ label: 'repo-gone', rows: matched, args });
				return;
			}

			if (mode.kind === 'all-orphans') {
				// Every row whose supervisor is not running. Use with
				// care — this includes idle stacks the user might still
				// want.
				const orphans = rows.filter((r) => r.runningPid === undefined || !isPidAlive(r.runningPid));
				yield* runBulkMode({ label: 'all-orphans', rows: orphans, args });
				return;
			}

			// Default: interactive picker. Hard requirement on a real TTY
			// so a CI shell can't hang waiting for keypresses.
			if (process.stdin.isTTY !== true) {
				return yield* failAlreadyReported(
					'devstack prune: interactive mode requires a TTY. Use `--list`, `<app>/<stack> --yes`, `--repo-gone --yes`, or `--all-orphans --yes`.',
				);
			}
			if (rows.length === 0) {
				yield* Console.log('(no devstack-labelled resources to prune)');
				return;
			}
			// Skip the picker if every row is running; nothing to select.
			const orphans = rows.filter((r) => r.runningPid === undefined);
			if (orphans.length === 0) {
				yield* Console.log(
					'prune: every stack has a running supervisor; stop one to free it up first.',
				);
				return;
			}
			const selected = yield* runInteractivePicker(rows);
			if (selected.length === 0) {
				yield* Console.log('prune: nothing selected, exiting.');
				return;
			}
			yield* pruneRows(selected, {
				keepSnapshots: args.keepSnapshots,
				images: args.images,
				dryRun: args.dryRun,
			});
			yield* maybePruneImages(args.includeImages, args.dryRun);
			yield* maybePruneForkCache(args.includeForkCache, args.dryRun);
		}),
).pipe(
	Command.withDescription(
		'Inventory + interactive cross-stack cleanup. `--list` to print, `--interactive` to pick, `<app>/<stack> --yes` to target, `--repo-gone --yes` to clean every stack whose repo is gone, `--all-orphans --yes` to nuke every idle stack.',
	),
);
