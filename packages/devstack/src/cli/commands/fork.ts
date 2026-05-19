// `devstack fork <sub>` — operator-facing surface for fork-mode stacks.
//
// All subcommands target the running stack's `sui-fork` container by:
//   1. Resolving the active stack name (precedence: `--stack` >
//      DEVSTACK_STACK > .devstack/active > 'main').
//   2. Reading the stack's `manifest.json` to discover the fork's gRPC
//      endpoint (`services.sui.rpc.url`).
//   3. Constructing a `SuiGrpcClient` against that URL — its
//      `forkingService` is the admin RPC client we need for `status`,
//      `advanceClock`, `advanceCheckpoint`, and `replayTo`.
//
// Subcommands:
//
//   status                      Print `forkedAtCheckpoint`, current
//                               `checkpointSequenceNumber`, `epoch`,
//                               `timestampMs`. `--json` for scripting.
//   advance-clock <durationMs>  Advance the on-chain clock by ms.
//   advance-checkpoint          Seal pending txs into a new checkpoint;
//                               `--count N` advances N times.
//   replay-to <checkpoint>      Repeatedly `advance-checkpoint` until
//                               the local sequence number reaches the
//                               target. Useful when running a script
//                               against a specific checkpoint anchor.
//   seed list                   Dump the on-disk meta.json's
//                               seedAddresses + seedObjects.
//   seed diff                   Compare on-disk meta.json against the
//                               configHash of a freshly-parsed
//                               devstack.config.ts. Exit 0 on match,
//                               1 on diff.
//   cache list                  Walk `.devstack/sui-fork-cache/` and
//                               report per-chainId size.
//   cache prune --unreferenced  Remove every cache entry not currently
//                               referenced by an active fork stack.

/* eslint-disable @typescript-eslint/no-explicit-any */

import { Console, Effect, FileSystem, Option, Path } from 'effect';
import { Argument, Command, Flag } from 'effect/unstable/cli';
import { SuiGrpcClient } from '@mysten/sui/grpc';
import { promises as nodeFs } from 'node:fs';
import { join as joinPath } from 'node:path';
import { Registry } from '../../engine/registry.js';
import {
	computeConfigHash,
	readForkMeta,
	resolveForkMetaPath as resolveEngineForkMetaPath,
} from '../../engine/sui-fork/meta.js';
import { formatBytes } from '../../engine/docker/inventory.js';
import { discoverManifestPath } from '../../runtime/discover-manifest.js';
import { failAlreadyReported } from '../already-reported.js';
import { resolveForkCacheRoot, resolveForkMetaPath, resolveStack } from '../stack-resolution.js';

const stackFlag = Flag.string('stack').pipe(
	Flag.withDescription('Stack to target (default: active stack, or "main")'),
	Flag.optional,
);

const jsonFlag = Flag.boolean('json').pipe(
	Flag.withDescription('Emit machine-readable JSON instead of a human summary'),
	Flag.withDefault(false),
);

// ---------------------------------------------------------------------------
// Manifest lookup — every admin subcommand needs the gRPC URL out of the
// running stack's manifest. Stack resolution gates the lookup (so two
// stacks on the same machine don't cross-talk).
// ---------------------------------------------------------------------------

interface ForkRuntimeContext {
	readonly stack: string;
	readonly rpcUrl: string;
	readonly upstream: 'mainnet' | 'testnet' | 'devnet';
	readonly chainId?: string;
}

const readManifestSuiBlock = async (
	manifestPath: string,
): Promise<
	| {
			network: string;
			chainId?: string;
			rpcUrl: string;
	  }
	| undefined
> => {
	try {
		const raw = await nodeFs.readFile(manifestPath, 'utf8');
		const parsed = JSON.parse(raw) as {
			services?: { sui?: { network?: string; chainId?: string; rpc?: { url?: string } } };
		};
		const sui = parsed.services?.sui;
		if (sui?.rpc?.url === undefined || sui.network === undefined) return undefined;
		return {
			network: sui.network,
			...(sui.chainId !== undefined ? { chainId: sui.chainId } : {}),
			rpcUrl: sui.rpc.url,
		};
	} catch {
		return undefined;
	}
};

const networkToUpstream = (network: string): 'mainnet' | 'testnet' | 'devnet' | undefined => {
	if (network === 'mainnet-fork' || network === 'mainnet') return 'mainnet';
	if (network === 'testnet-fork' || network === 'testnet') return 'testnet';
	if (network === 'devnet-fork' || network === 'devnet') return 'devnet';
	return undefined;
};

const resolveForkRuntimeCtx = (stack: string) =>
	Effect.tryPromise({
		try: async (): Promise<ForkRuntimeContext> => {
			const manifestPath =
				discoverManifestPath({ stack }) ??
				joinPath(process.cwd(), '.devstack', 'stacks', stack, 'manifest.json');
			const sui = await readManifestSuiBlock(manifestPath);
			if (sui === undefined) {
				throw new Error(
					`devstack fork: no fork stack found for stack='${stack}'. Looked for ` +
						`a manifest.json under .devstack/stacks/${stack}/ with services.sui.rpc.url set. ` +
						`Run \`devstack apply\` (or \`devstack up\`) first.`,
				);
			}
			const upstream = networkToUpstream(sui.network);
			if (upstream === undefined) {
				throw new Error(
					`devstack fork: manifest's services.sui.network='${sui.network}' is not a fork ` +
						`variant. The fork subcommands only work on \`mainnet-fork\` / \`testnet-fork\` / ` +
						`\`devnet-fork\` stacks.`,
				);
			}
			return {
				stack,
				rpcUrl: sui.rpcUrl,
				upstream,
				...(sui.chainId !== undefined ? { chainId: sui.chainId } : {}),
			};
		},
		catch: (cause) => new Error(String(cause)),
	}).pipe(
		Effect.catch((cause: Error) =>
			Effect.gen(function* () {
				yield* failAlreadyReported(cause.message);
				return undefined as never;
			}),
		),
	);

/** Build a `SuiGrpcClient` against the running fork's RPC URL. The
 *  client's `forkingService` carries the admin RPCs we wire each
 *  subcommand to. */
const makeForkClient = (ctx: ForkRuntimeContext): SuiGrpcClient =>
	new SuiGrpcClient({ baseUrl: ctx.rpcUrl, network: ctx.upstream });

// ---------------------------------------------------------------------------
// `fork status`
// ---------------------------------------------------------------------------

const statusCommand = Command.make(
	'status',
	{
		stack: stackFlag,
		json: jsonFlag,
	},
	({ stack, json }) =>
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;
			const path = yield* Path.Path;
			const resolved = yield* resolveStack(fs, path, stack);
			const ctx = yield* resolveForkRuntimeCtx(resolved);
			const client = makeForkClient(ctx);
			const status = yield* Effect.tryPromise({
				try: () => client.forkingService.getStatus({}).response,
				catch: (cause) => new Error(`fork status: GetStatus failed — ${String(cause)}`),
			}).pipe(
				Effect.catch((cause) =>
					Effect.gen(function* () {
						yield* failAlreadyReported(cause.message);
						return undefined as never;
					}),
				),
			);
			const body = {
				stack: ctx.stack,
				rpcUrl: ctx.rpcUrl,
				upstream: ctx.upstream,
				...(ctx.chainId !== undefined ? { chainId: ctx.chainId } : {}),
				forkedAtCheckpoint: Number(status.forkedAtCheckpoint),
				checkpointSequenceNumber: Number(status.checkpointSequenceNumber),
				epoch: Number(status.epoch),
				timestampMs: Number(status.timestampMs),
			};
			if (json) {
				yield* Console.log(JSON.stringify(body));
				return;
			}
			yield* Console.log(`fork status (stack='${ctx.stack}', upstream=${ctx.upstream}):`);
			if (ctx.chainId !== undefined) {
				yield* Console.log(`  chainId:                  ${ctx.chainId}`);
			}
			yield* Console.log(`  rpc:                      ${ctx.rpcUrl}`);
			yield* Console.log(`  forkedAtCheckpoint:       ${body.forkedAtCheckpoint}`);
			yield* Console.log(`  checkpointSequenceNumber: ${body.checkpointSequenceNumber}`);
			yield* Console.log(`  epoch:                    ${body.epoch}`);
			yield* Console.log(`  clockMs:                  ${body.timestampMs}`);
		}),
).pipe(
	Command.withDescription("Print the running fork stack's `ForkingService.GetStatus` response"),
);

// ---------------------------------------------------------------------------
// `fork advance-clock <durationMs>`
// ---------------------------------------------------------------------------

const advanceClockCommand = Command.make(
	'advance-clock',
	{
		duration: Argument.string('durationMs').pipe(
			Argument.withDescription('Milliseconds to advance the on-chain clock by'),
		),
		stack: stackFlag,
		json: jsonFlag,
	},
	({ duration, stack, json }) =>
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;
			const path = yield* Path.Path;
			const resolved = yield* resolveStack(fs, path, stack);
			const parsedDuration = Number.parseInt(duration, 10);
			if (!Number.isFinite(parsedDuration) || parsedDuration <= 0) {
				return yield* failAlreadyReported(
					`fork advance-clock: durationMs must be a positive integer (got '${duration}')`,
				);
			}
			const ctx = yield* resolveForkRuntimeCtx(resolved);
			const client = makeForkClient(ctx);
			const resp = yield* Effect.tryPromise({
				try: () =>
					client.forkingService.advanceClock({ durationMs: BigInt(parsedDuration) }).response,
				catch: (cause) => new Error(`fork advance-clock: AdvanceClock failed — ${String(cause)}`),
			}).pipe(
				Effect.catch((cause) =>
					Effect.gen(function* () {
						yield* failAlreadyReported(cause.message);
						return undefined as never;
					}),
				),
			);
			const body = {
				stack: ctx.stack,
				advancedMs: parsedDuration,
				newTimestampMs: Number(resp.timestampMs),
				txDigest: resp.txDigest,
			};
			if (json) {
				yield* Console.log(JSON.stringify(body));
				return;
			}
			yield* Console.log(
				`fork advance-clock: advanced by ${parsedDuration}ms; new clockMs=${body.newTimestampMs} ` +
					`(consensus-commit-prologue tx=${body.txDigest})`,
			);
		}),
).pipe(Command.withDescription("Advance the fork's on-chain clock by N milliseconds"));

// ---------------------------------------------------------------------------
// `fork advance-checkpoint [--count N]`
// ---------------------------------------------------------------------------

const advanceCheckpointCommand = Command.make(
	'advance-checkpoint',
	{
		count: Flag.string('count').pipe(
			Flag.withDescription('Number of checkpoints to advance (default 1)'),
			Flag.withDefault('1'),
		),
		stack: stackFlag,
		json: jsonFlag,
	},
	({ count, stack, json }) =>
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;
			const path = yield* Path.Path;
			const resolved = yield* resolveStack(fs, path, stack);
			const parsedCount = Number.parseInt(count, 10);
			if (!Number.isFinite(parsedCount) || parsedCount <= 0) {
				return yield* failAlreadyReported(
					`fork advance-checkpoint: --count must be a positive integer (got '${count}')`,
				);
			}
			const ctx = yield* resolveForkRuntimeCtx(resolved);
			const client = makeForkClient(ctx);
			const advances: Array<{ checkpointSequenceNumber: number; timestampMs: number }> = [];
			for (let i = 0; i < parsedCount; i++) {
				const resp = yield* Effect.tryPromise({
					try: () => client.forkingService.advanceCheckpoint({}).response,
					catch: (cause) =>
						new Error(`fork advance-checkpoint: AdvanceCheckpoint failed — ${String(cause)}`),
				}).pipe(
					Effect.catch((cause) =>
						Effect.gen(function* () {
							yield* failAlreadyReported(cause.message);
							return undefined as never;
						}),
					),
				);
				advances.push({
					checkpointSequenceNumber: Number(resp.checkpointSequenceNumber),
					timestampMs: Number(resp.timestampMs),
				});
			}
			const body = {
				stack: ctx.stack,
				count: parsedCount,
				advances,
				latestCheckpoint:
					advances.length > 0 ? advances[advances.length - 1]!.checkpointSequenceNumber : undefined,
			};
			if (json) {
				yield* Console.log(JSON.stringify(body));
				return;
			}
			yield* Console.log(
				`fork advance-checkpoint: advanced ${parsedCount} checkpoint${parsedCount === 1 ? '' : 's'}` +
					(body.latestCheckpoint !== undefined ? `; latest=${body.latestCheckpoint}` : ''),
			);
		}),
).pipe(Command.withDescription('Seal pending txs into N new checkpoints (default 1)'));

// ---------------------------------------------------------------------------
// `fork replay-to <checkpoint>`
// ---------------------------------------------------------------------------

const replayToCommand = Command.make(
	'replay-to',
	{
		target: Argument.string('checkpoint').pipe(
			Argument.withDescription('Target local checkpoint sequence number'),
		),
		stack: stackFlag,
		json: jsonFlag,
	},
	({ target, stack, json }) =>
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;
			const path = yield* Path.Path;
			const resolved = yield* resolveStack(fs, path, stack);
			const parsedTarget = Number.parseInt(target, 10);
			if (!Number.isFinite(parsedTarget) || parsedTarget < 0) {
				return yield* failAlreadyReported(
					`fork replay-to: target must be a non-negative integer (got '${target}')`,
				);
			}
			const ctx = yield* resolveForkRuntimeCtx(resolved);
			const client = makeForkClient(ctx);
			const initial = yield* Effect.tryPromise({
				try: () => client.forkingService.getStatus({}).response,
				catch: (cause) => new Error(`fork replay-to: GetStatus failed — ${String(cause)}`),
			}).pipe(
				Effect.catch((cause) =>
					Effect.gen(function* () {
						yield* failAlreadyReported(cause.message);
						return undefined as never;
					}),
				),
			);
			let current = Number(initial.checkpointSequenceNumber);
			if (current >= parsedTarget) {
				const body = {
					stack: ctx.stack,
					target: parsedTarget,
					initial: current,
					final: current,
					advanced: 0,
					noop: true,
				};
				if (json) {
					yield* Console.log(JSON.stringify(body));
					return;
				}
				yield* Console.log(
					`fork replay-to: no-op — already at checkpoint ${current} (>= target ${parsedTarget})`,
				);
				return;
			}
			let advanced = 0;
			while (current < parsedTarget) {
				const resp = yield* Effect.tryPromise({
					try: () => client.forkingService.advanceCheckpoint({}).response,
					catch: (cause) =>
						new Error(
							`fork replay-to: AdvanceCheckpoint failed at ${current}/${parsedTarget} — ${String(cause)}`,
						),
				}).pipe(
					Effect.catch((cause) =>
						Effect.gen(function* () {
							yield* failAlreadyReported(cause.message);
							return undefined as never;
						}),
					),
				);
				current = Number(resp.checkpointSequenceNumber);
				advanced += 1;
			}
			const body = {
				stack: ctx.stack,
				target: parsedTarget,
				initial: Number(initial.checkpointSequenceNumber),
				final: current,
				advanced,
				noop: false,
			};
			if (json) {
				yield* Console.log(JSON.stringify(body));
				return;
			}
			yield* Console.log(
				`fork replay-to: advanced ${advanced} checkpoint${advanced === 1 ? '' : 's'} ` +
					`from ${body.initial} to ${current}`,
			);
		}),
).pipe(
	Command.withDescription(
		'Repeatedly advance-checkpoint until the local sequence reaches the target',
	),
);

// ---------------------------------------------------------------------------
// `fork seed list`
// ---------------------------------------------------------------------------

const seedListCommand = Command.make(
	'list',
	{
		stack: stackFlag,
		json: jsonFlag,
	},
	({ stack, json }) =>
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;
			const path = yield* Path.Path;
			const resolved = yield* resolveStack(fs, path, stack);
			const metaPath = resolveForkMetaPath({ stack: resolved });
			const meta = yield* readForkMeta(metaPath);
			if (meta === undefined) {
				return yield* failAlreadyReported(
					`fork seed list: no meta.json at ${metaPath}. Run \`devstack apply\` against a ` +
						`fork-mode stack first.`,
				);
			}
			const body = {
				stack: resolved,
				metaPath,
				upstream: meta.upstream,
				...(meta.checkpoint !== undefined ? { checkpoint: meta.checkpoint } : {}),
				configHash: meta.configHash,
				seedAddresses: meta.seedAddresses,
				seedObjects: meta.seedObjects,
			};
			if (json) {
				yield* Console.log(JSON.stringify(body));
				return;
			}
			yield* Console.log(`fork seed list (stack='${resolved}'):`);
			yield* Console.log(`  meta:        ${metaPath}`);
			yield* Console.log(
				`  upstream:    ${meta.upstream}` +
					(meta.checkpoint !== undefined ? ` @ checkpoint ${meta.checkpoint}` : ' @ latest'),
			);
			yield* Console.log(`  configHash:  ${meta.configHash}`);
			yield* Console.log(`  addresses (${meta.seedAddresses.length}):`);
			if (meta.seedAddresses.length === 0) {
				yield* Console.log(`    (none)`);
			} else {
				for (const a of meta.seedAddresses) yield* Console.log(`    ${a}`);
			}
			yield* Console.log(`  objects   (${meta.seedObjects.length}):`);
			if (meta.seedObjects.length === 0) {
				yield* Console.log(`    (none)`);
			} else {
				for (const o of meta.seedObjects) yield* Console.log(`    ${o}`);
			}
		}),
).pipe(Command.withDescription("Print the on-disk meta.json's seed addresses + objects"));

// ---------------------------------------------------------------------------
// `fork seed diff`
//
// Compares the on-disk meta.json against the configHash derived from a
// caller-supplied configuration snapshot. Two acceptance modes:
//   1. `--upstream <name> --checkpoint <n> --address <a>...` flags
//      provide the comparison config directly.
//   2. No flags: just print the on-disk hash (caller can pipe to a
//      diff against the config emitted by `devstack apply --json`).
//
// Exit code: 0 on match (or pure-print mode); 1 on diff. Mirrors the
// shell convention so CI can `if ! devstack fork seed diff …; then …`.
// ---------------------------------------------------------------------------

const seedDiffCommand = Command.make(
	'diff',
	{
		upstream: Flag.string('upstream').pipe(
			Flag.withDescription('Upstream network to compare against (e.g. mainnet)'),
			Flag.optional,
		),
		checkpoint: Flag.string('checkpoint').pipe(
			Flag.withDescription('Pinned checkpoint to compare against'),
			Flag.optional,
		),
		addresses: Flag.string('addresses').pipe(
			Flag.withDescription('Comma-separated seed addresses to compare against'),
			Flag.optional,
		),
		objects: Flag.string('objects').pipe(
			Flag.withDescription('Comma-separated seed object ids to compare against'),
			Flag.optional,
		),
		stack: stackFlag,
		json: jsonFlag,
	},
	({ upstream, checkpoint, addresses, objects, stack, json }) =>
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;
			const path = yield* Path.Path;
			const resolved = yield* resolveStack(fs, path, stack);
			const metaPath = resolveForkMetaPath({ stack: resolved });
			const meta = yield* readForkMeta(metaPath);
			if (meta === undefined) {
				return yield* failAlreadyReported(
					`fork seed diff: no meta.json at ${metaPath}. Run \`devstack apply\` first.`,
				);
			}
			const upstreamV = Option.getOrUndefined(upstream);
			const checkpointV = Option.getOrUndefined(checkpoint);
			const addressesV = Option.getOrUndefined(addresses);
			const objectsV = Option.getOrUndefined(objects);
			if (upstreamV === undefined) {
				const body = {
					stack: resolved,
					metaPath,
					upstream: meta.upstream,
					...(meta.checkpoint !== undefined ? { checkpoint: meta.checkpoint } : {}),
					configHash: meta.configHash,
					mode: 'print-only',
				};
				if (json) {
					yield* Console.log(JSON.stringify(body));
				} else {
					yield* Console.log(`fork seed diff: on-disk configHash=${meta.configHash}`);
					yield* Console.log(`(pass --upstream/--checkpoint/--addresses/--objects to compare)`);
				}
				return;
			}
			const parsedCheckpoint =
				checkpointV !== undefined ? Number.parseInt(checkpointV, 10) : undefined;
			if (
				parsedCheckpoint !== undefined &&
				(!Number.isFinite(parsedCheckpoint) || parsedCheckpoint < 0)
			) {
				return yield* failAlreadyReported(
					`fork seed diff: --checkpoint must be a non-negative integer (got '${checkpointV}')`,
				);
			}
			const parsedAddresses =
				addressesV !== undefined
					? addressesV
							.split(',')
							.map((s) => s.trim())
							.filter((s) => s.length > 0)
					: [];
			const parsedObjects =
				objectsV !== undefined
					? objectsV
							.split(',')
							.map((s) => s.trim())
							.filter((s) => s.length > 0)
					: [];
			const proposedHash = computeConfigHash({
				upstream: upstreamV,
				...(parsedCheckpoint !== undefined ? { checkpoint: parsedCheckpoint } : {}),
				seedAddresses: parsedAddresses,
				seedObjects: parsedObjects,
			});
			const match = proposedHash === meta.configHash;
			const body = {
				stack: resolved,
				metaPath,
				match,
				onDisk: {
					upstream: meta.upstream,
					...(meta.checkpoint !== undefined ? { checkpoint: meta.checkpoint } : {}),
					configHash: meta.configHash,
					seedAddresses: meta.seedAddresses,
					seedObjects: meta.seedObjects,
				},
				proposed: {
					upstream: upstreamV,
					...(parsedCheckpoint !== undefined ? { checkpoint: parsedCheckpoint } : {}),
					configHash: proposedHash,
					seedAddresses: [...parsedAddresses].map((s) => s.toLowerCase()).sort(),
					seedObjects: [...parsedObjects].map((s) => s.toLowerCase()).sort(),
				},
			};
			if (json) {
				yield* Console.log(JSON.stringify(body));
			} else if (match) {
				yield* Console.log(`fork seed diff: match (configHash=${meta.configHash})`);
			} else {
				yield* Console.log(`fork seed diff: MISMATCH`);
				yield* Console.log(`  on-disk:  ${body.onDisk.configHash}`);
				yield* Console.log(`  proposed: ${body.proposed.configHash}`);
				yield* Console.log(
					`  on-disk addresses (${body.onDisk.seedAddresses.length}): ${body.onDisk.seedAddresses.join(', ') || '(none)'}`,
				);
				yield* Console.log(
					`  proposed addresses (${body.proposed.seedAddresses.length}): ${body.proposed.seedAddresses.join(', ') || '(none)'}`,
				);
			}
			if (!match) {
				return yield* failAlreadyReported('fork seed diff: configurations differ');
			}
		}),
).pipe(
	Command.withDescription(
		'Compare the on-disk meta.json against a supplied config (--upstream/--checkpoint/--addresses/--objects). Exit 1 on diff.',
	),
);

const seedCommand = Command.make('seed').pipe(
	Command.withDescription('Inspect the per-stack fork seed manifest'),
	Command.withSubcommands([seedListCommand, seedDiffCommand]),
);

// ---------------------------------------------------------------------------
// `fork cache list`
// ---------------------------------------------------------------------------

interface CacheEntry {
	readonly chainId: string;
	readonly path: string;
	readonly bytes: number;
	readonly referenced: boolean;
}

const safeStatSize = async (path: string): Promise<number> => {
	try {
		const stat = await nodeFs.stat(path);
		if (stat.isDirectory()) {
			let total = 0;
			const entries = await nodeFs.readdir(path);
			for (const entry of entries) {
				total += await safeStatSize(joinPath(path, entry));
			}
			return total;
		}
		return stat.size;
	} catch {
		return 0;
	}
};

const collectCacheEntries = async (
	cacheRoot: string,
	referencedChainIds: ReadonlySet<string>,
): Promise<ReadonlyArray<CacheEntry>> => {
	let entries: ReadonlyArray<string>;
	try {
		entries = await nodeFs.readdir(cacheRoot);
	} catch {
		return [];
	}
	const out: Array<CacheEntry> = [];
	for (const entry of entries) {
		const full = joinPath(cacheRoot, entry);
		const stat = await nodeFs.stat(full).catch(() => undefined);
		if (stat === undefined || !stat.isDirectory()) continue;
		const bytes = await safeStatSize(full);
		out.push({
			chainId: entry,
			path: full,
			bytes,
			referenced: referencedChainIds.has(entry),
		});
	}
	return out;
};

/** Walk every per-stack meta.json under `.devstack/stacks/* /sui-fork/`
 *  collecting the set of referenced chain ids. For now we approximate
 *  the chainId from the meta's upstream (mainnet → mainnet's real chain
 *  id) since meta.json doesn't carry chainId directly — the supervisor
 *  could populate it but that's a Phase 4 enhancement. We use the
 *  meta's `upstream` as the cache key for the heuristic. */
const collectReferencedChainIds = async (stateRoot: string): Promise<ReadonlySet<string>> => {
	const stacksDir = joinPath(stateRoot, 'stacks');
	const out = new Set<string>();
	let stacks: ReadonlyArray<string>;
	try {
		stacks = await nodeFs.readdir(stacksDir);
	} catch {
		return out;
	}
	for (const stack of stacks) {
		const metaPath = joinPath(stacksDir, stack, 'sui-fork', 'meta.json');
		try {
			const raw = await nodeFs.readFile(metaPath, 'utf8');
			const parsed = JSON.parse(raw) as {
				upstream?: string;
				chainId?: string;
			};
			if (parsed.chainId !== undefined) out.add(parsed.chainId);
			// Also fold the upstream name in as a fallback so a cache
			// dir keyed by `'mainnet'` is treated as referenced even
			// when chainId wasn't recorded.
			if (parsed.upstream !== undefined) out.add(parsed.upstream);
		} catch {
			// best-effort
		}
	}
	return out;
};

const cacheListCommand = Command.make('list', { json: jsonFlag }, ({ json }) =>
	Effect.gen(function* () {
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
		if (json) {
			yield* Console.log(JSON.stringify(body));
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

// ---------------------------------------------------------------------------
// `fork cache prune --unreferenced`
// ---------------------------------------------------------------------------

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
				if (json) {
					yield* Console.log(JSON.stringify(empty));
				} else {
					yield* Console.log(`fork cache prune: nothing to remove (kept ${empty.kept} entries)`);
				}
				return;
			}
			const removed: Array<string> = [];
			if (dryRun) {
				if (json) {
					yield* Console.log(
						JSON.stringify({ cacheRoot, dryRun: true, wouldRemove: targets.map((t) => t.path) }),
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
			if (json) {
				yield* Console.log(JSON.stringify({ cacheRoot, removed }));
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

const cacheCommand = Command.make('cache').pipe(
	Command.withDescription('Inspect / prune the shared .devstack/sui-fork-cache/ upstream cache'),
	Command.withSubcommands([cacheListCommand, cachePruneCommand]),
);

// ---------------------------------------------------------------------------
// Root `fork` command
// ---------------------------------------------------------------------------

export const forkCommand = Command.make('fork').pipe(
	Command.withDescription(
		'Inspect + drive `sui-fork`-backed stacks (status, advance-*, seed, cache)',
	),
	Command.withSubcommands([
		statusCommand,
		advanceClockCommand,
		advanceCheckpointCommand,
		replayToCommand,
		seedCommand,
		cacheCommand,
	]),
);

/** Re-exported helper for tests that want to construct a status-style
 *  payload without going through the CLI parser. */
export const _internal = {
	resolveForkRuntimeCtx,
	resolveEngineForkMetaPath,
	collectReferencedChainIds,
	collectCacheEntries,
};

// `Registry` is only re-exported here so the `_internal` block keeps
// the type import chain reachable for downstream tooling that needs to
// stub the running stack's gRPC endpoint. The CLI itself doesn't read
// from the registry — manifest lookup is the canonical path.
void Registry;
