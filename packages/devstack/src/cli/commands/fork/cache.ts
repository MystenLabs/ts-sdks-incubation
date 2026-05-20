// `devstack fork cache <list|prune>` — list reports per-chainId size
// under .devstack/sui-fork-cache/ with referenced/orphan marks; prune
// `--unreferenced --yes` (or --dry-run) removes orphans. Cache walks
// live in engine/sui-fork/cache-inventory.ts (shared with prune.ts).

/* eslint-disable @typescript-eslint/no-explicit-any */

import { Console, Effect } from 'effect';
import { Command, Flag } from 'effect/unstable/cli';
import { promises as nodeFs } from 'node:fs';
import { join as joinPath } from 'node:path';
import {
	collectCacheEntries,
	collectReferencedChainIds,
} from '../../../engine/sui-fork/cache-inventory.js';
import { formatBytes } from '../../../engine/docker/inventory.js';
import { failAlreadyReported } from '../../already-reported.js';
import { emitEnvelope, jsonModeEnabled, successEnvelope } from '../../envelope.js';
import { resolveForkCacheRoot } from '../../stack-resolution.js';
import { jsonFlag } from './_shared.js';

const cacheListCommand = Command.make('list', { json: jsonFlag }, ({ json }) =>
	Effect.gen(function* () {
		const startedAt = Date.now();
		const useJson = jsonModeEnabled(json);
		const cacheRoot = resolveForkCacheRoot();
		const stateRoot = joinPath(cacheRoot, '..');
		const referenced = yield* Effect.promise(() => collectReferencedChainIds(stateRoot));
		const entries = yield* Effect.promise(() => collectCacheEntries(cacheRoot, referenced));
		const body = {
			cacheRoot,
			entries: entries.map((e) => ({
				chainId: e.chainId,
				path: e.path,
				bytes: e.bytes,
				referenced: e.referenced,
			})),
		};
		if (useJson) {
			yield* emitEnvelope(
				successEnvelope({
					command: 'fork.cache.list',
					data: body,
					elapsedMs: Date.now() - startedAt,
				}),
			);
			return;
		}
		yield* Console.log(`fork cache list (${cacheRoot}):`);
		if (entries.length === 0) {
			yield* Console.log(`  (empty)`);
			return;
		}
		for (const e of entries) {
			const marker = e.referenced ? '*' : ' ';
			yield* Console.log(
				`  ${marker} ${e.chainId.padEnd(40)} ${formatBytes(e.bytes).padStart(8)} (${e.path})`,
			);
		}
		yield* Console.log(`(* = referenced by an active fork stack)`);
	}),
).pipe(
	Command.withDescription(
		'List entries under .devstack/sui-fork-cache/ with size + reference status',
	),
);

const cachePruneCommand = Command.make(
	'prune',
	{
		unreferenced: Flag.boolean('unreferenced').pipe(
			Flag.withDescription('Remove cache entries not referenced by any active fork stack'),
			Flag.withDefault(false),
		),
		yes: Flag.boolean('yes').pipe(
			Flag.withDescription('Required to mutate disk state'),
			Flag.withDefault(false),
		),
		dryRun: Flag.boolean('dry-run').pipe(
			Flag.withDescription('Print what would happen without removing anything'),
			Flag.withDefault(false),
		),
		json: jsonFlag,
	},
	({ unreferenced, yes, dryRun, json }) =>
		Effect.gen(function* () {
			const startedAt = Date.now();
			const useJson = jsonModeEnabled(json);
			if (!unreferenced) {
				return yield* failAlreadyReported(
					'fork cache prune: pass --unreferenced (other modes are reserved for future work)',
				);
			}
			if (!yes && !dryRun) {
				return yield* failAlreadyReported(
					'fork cache prune --unreferenced: --yes (or --dry-run) is required',
				);
			}
			const cacheRoot = resolveForkCacheRoot();
			const stateRoot = joinPath(cacheRoot, '..');
			const referenced = yield* Effect.promise(() => collectReferencedChainIds(stateRoot));
			const entries = yield* Effect.promise(() => collectCacheEntries(cacheRoot, referenced));
			const targets = entries.filter((e) => !e.referenced);
			if (targets.length === 0) {
				const empty = { cacheRoot, removed: [] as Array<string>, kept: entries.length };
				if (useJson) {
					yield* emitEnvelope(
						successEnvelope({
							command: 'fork.cache.prune',
							data: empty,
							elapsedMs: Date.now() - startedAt,
							...(dryRun ? { dryRun: true } : {}),
						}),
					);
				} else {
					yield* Console.log(`fork cache prune: nothing to remove (kept ${empty.kept} entries)`);
				}
				return;
			}
			const removed: Array<string> = [];
			if (dryRun) {
				if (useJson) {
					yield* emitEnvelope(
						successEnvelope({
							command: 'fork.cache.prune',
							data: { cacheRoot, wouldRemove: targets.map((t) => t.path) },
							elapsedMs: Date.now() - startedAt,
							dryRun: true,
						}),
					);
				} else {
					for (const t of targets) {
						yield* Console.log(`  would remove ${t.path} (${formatBytes(t.bytes)})`);
					}
				}
				return;
			}
			for (const t of targets) {
				yield* Effect.promise(() => nodeFs.rm(t.path, { recursive: true, force: true }));
				removed.push(t.path);
			}
			if (useJson) {
				yield* emitEnvelope(
					successEnvelope({
						command: 'fork.cache.prune',
						data: { cacheRoot, removed },
						elapsedMs: Date.now() - startedAt,
					}),
				);
			} else {
				yield* Console.log(
					`fork cache prune: removed ${removed.length} unreferenced ` +
						`entr${removed.length === 1 ? 'y' : 'ies'} (kept ${entries.length - removed.length})`,
				);
			}
		}),
).pipe(
	Command.withDescription(
		'Remove cache entries under .devstack/sui-fork-cache/ that no active fork stack references',
	),
);

export const cacheCommand = Command.make('cache').pipe(
	Command.withDescription('Inspect / prune the shared .devstack/sui-fork-cache/ upstream cache'),
	Command.withSubcommands([cacheListCommand, cachePruneCommand]),
);
