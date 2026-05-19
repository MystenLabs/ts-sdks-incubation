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

import { Console, Effect, FileSystem, Option, Path, Stream } from 'effect';
import { Argument, Command, Flag } from 'effect/unstable/cli';
import { SuiGrpcClient } from '@mysten/sui/grpc';
import { promises as nodeFs } from 'node:fs';
import { join as joinPath } from 'node:path';
import {
	subscribeCheckpointsWithFallback,
	type ForkCheckpointEvent,
} from '../../engine/sui-fork/control.js';
import {
	computeConfigHash,
	readForkMeta,
	resolveForkMetaPath as resolveEngineForkMetaPath,
} from '../../engine/sui-fork/meta.js';
import {
	collectCacheEntries,
	collectReferencedChainIds,
} from '../../engine/sui-fork/cache-inventory.js';
import { formatBytes } from '../../engine/docker/inventory.js';
import { readStackContext } from '../../runtime/read-stack-context.js';
import { AlreadyReportedError, failAlreadyReported } from '../already-reported.js';
import { emitEnvelope, jsonModeEnabled, successEnvelope } from '../envelope.js';
import { EX_SEED_MISMATCH } from '../exit-codes.js';
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

const networkToUpstream = (network: string): 'mainnet' | 'testnet' | 'devnet' | undefined => {
	if (network === 'mainnet-fork' || network === 'mainnet') return 'mainnet';
	if (network === 'testnet-fork' || network === 'testnet') return 'testnet';
	if (network === 'devnet-fork' || network === 'devnet') return 'devnet';
	return undefined;
};

const resolveForkRuntimeCtx = (stack: string) =>
	readStackContext({ stack }).pipe(
		Effect.flatMap((ctx) => {
			const sui = ctx.sui;
			if (sui === undefined) {
				return failAlreadyReported(
					`devstack fork: no fork stack found for stack='${stack}'. Looked for ` +
						`a manifest.json under .devstack/stacks/${stack}/ with services.sui.rpc.url set. ` +
						`Run \`devstack apply\` (or \`devstack up\`) first.`,
				);
			}
			const upstream = networkToUpstream(sui.network);
			if (upstream === undefined) {
				return failAlreadyReported(
					`devstack fork: manifest's services.sui.network='${sui.network}' is not a fork ` +
						`variant. The fork subcommands only work on \`mainnet-fork\` / \`testnet-fork\` / ` +
						`\`devnet-fork\` stacks.`,
				);
			}
			return Effect.succeed<ForkRuntimeContext>({
				stack,
				rpcUrl: sui.rpc.url,
				upstream,
				...(sui.chainId !== undefined ? { chainId: sui.chainId } : {}),
			});
		}),
		Effect.catchTags({
			ManifestDiscoveryError: (cause) => failAlreadyReported(cause.message),
			ManifestShapeError: (cause) => failAlreadyReported(cause.message),
		}),
	);

/** Build a `SuiGrpcClient` against the running fork's RPC URL. The
 *  client's `forkingService` carries the admin RPCs we wire each
 *  subcommand to. */
const makeForkClient = (ctx: ForkRuntimeContext): SuiGrpcClient =>
	new SuiGrpcClient({ baseUrl: ctx.rpcUrl, network: ctx.upstream });

/** Run a `ForkingService` admin RPC, formatting any rejection as a
 *  `<label> failed — <cause>` message and re-raising as
 *  `AlreadyReportedError`. Every `fork <sub>` command body that talks to
 *  the fork's gRPC admin surface uses this — the alternative is the
 *  five-line `Effect.tryPromise → Effect.catch → failAlreadyReported`
 *  chain repeated at every call site. */
const wrapForkRpc = <T>(
	label: string,
	fn: () => Promise<T>,
): Effect.Effect<T, AlreadyReportedError> =>
	Effect.tryPromise({
		try: fn,
		catch: (cause) => new Error(`${label} failed — ${String(cause)}`),
	}).pipe(
		Effect.catch((cause) =>
			Effect.gen(function* () {
				yield* failAlreadyReported(cause.message);
				return undefined as never;
			}),
		),
	);

// ---------------------------------------------------------------------------
// `fork status`
// ---------------------------------------------------------------------------

const followFlag = Flag.boolean('follow').pipe(
	Flag.withDescription(
		'Stream `SubscribeCheckpoints` events instead of one-shot. ' +
			'Falls back to polling on stream error.',
	),
	Flag.withDefault(false),
);

const statusCommand = Command.make(
	'status',
	{
		stack: stackFlag,
		json: jsonFlag,
		follow: followFlag,
	},
	({ stack, json, follow }) =>
		Effect.gen(function* () {
			const startedAt = Date.now();
			const useJson = jsonModeEnabled(json);
			const fs = yield* FileSystem.FileSystem;
			const path = yield* Path.Path;
			const resolved = yield* resolveStack(fs, path, stack);
			const ctx = yield* resolveForkRuntimeCtx(resolved);
			const client = makeForkClient(ctx);
			const status = yield* wrapForkRpc('fork status: GetStatus', () =>
				client.forkingService.getStatus({}).response,
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
			if (useJson) {
				yield* emitEnvelope(
					successEnvelope({
						command: 'fork.status',
						data: body,
						elapsedMs: Date.now() - startedAt,
					}),
				);
			} else {
				yield* Console.log(`fork status (stack='${ctx.stack}', upstream=${ctx.upstream}):`);
				if (ctx.chainId !== undefined) {
					yield* Console.log(`  chainId:                  ${ctx.chainId}`);
				}
				yield* Console.log(`  rpc:                      ${ctx.rpcUrl}`);
				yield* Console.log(`  forkedAtCheckpoint:       ${body.forkedAtCheckpoint}`);
				yield* Console.log(`  checkpointSequenceNumber: ${body.checkpointSequenceNumber}`);
				yield* Console.log(`  epoch:                    ${body.epoch}`);
				yield* Console.log(`  clockMs:                  ${body.timestampMs}`);
			}
			if (!follow) return;

			// `--follow` consumes the subscription stream until the
			// scope tears down (Ctrl-C) or the upstream completes.
			// Each event still emits as its own JSON line under --json
			// for backward compatibility — wrapping the stream of
			// events in a single envelope would defeat the point.
			yield* Console.log(
				useJson
					? ''
					: `following checkpoint stream (Ctrl-C to stop, source=subscription→poll on error)…`,
			);
			yield* subscribeCheckpointsWithFallback(client).pipe(
				Stream.runForEach((event: ForkCheckpointEvent) =>
					useJson
						? Console.log(JSON.stringify(event))
						: Console.log(
								`  [${new Date(event.receivedAtMs).toISOString()}] checkpoint=${event.cursor} (${event.source})`,
							),
				),
				Effect.catch((cause) =>
					failAlreadyReported(`fork status --follow: ${cause.message ?? String(cause)}`),
				),
			);
		}),
).pipe(
	Command.withDescription(
		"Print the running fork stack's `ForkingService.GetStatus` response. " +
			'Pass `--follow` to stream checkpoint events instead of one-shot.',
	),
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
		dryRun: Flag.boolean('dry-run').pipe(
			Flag.withDescription('Resolve the target and exit without invoking AdvanceClock'),
			Flag.withDefault(false),
		),
	},
	({ duration, stack, json, dryRun }) =>
		Effect.gen(function* () {
			const startedAt = Date.now();
			const useJson = jsonModeEnabled(json);
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
			if (dryRun) {
				if (useJson) {
					yield* emitEnvelope(
						successEnvelope({
							command: 'fork.advance-clock',
							data: {
								stack: ctx.stack,
								wouldAdvanceMs: parsedDuration,
								rpcUrl: ctx.rpcUrl,
							},
							elapsedMs: Date.now() - startedAt,
							dryRun: true,
						}),
					);
				} else {
					yield* Console.log(
						`would advance clock by ${parsedDuration}ms against ${ctx.rpcUrl} — dry run`,
					);
				}
				return;
			}
			const client = makeForkClient(ctx);
			const resp = yield* wrapForkRpc(
				'fork advance-clock: AdvanceClock',
				() => client.forkingService.advanceClock({ durationMs: BigInt(parsedDuration) }).response,
			);
			const body = {
				stack: ctx.stack,
				advancedMs: parsedDuration,
				newTimestampMs: Number(resp.timestampMs),
				txDigest: resp.txDigest,
			};
			if (useJson) {
				yield* emitEnvelope(
					successEnvelope({
						command: 'fork.advance-clock',
						data: body,
						elapsedMs: Date.now() - startedAt,
					}),
				);
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
		dryRun: Flag.boolean('dry-run').pipe(
			Flag.withDescription('Resolve the target and exit without sealing checkpoints'),
			Flag.withDefault(false),
		),
	},
	({ count, stack, json, dryRun }) =>
		Effect.gen(function* () {
			const startedAt = Date.now();
			const useJson = jsonModeEnabled(json);
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
			if (dryRun) {
				if (useJson) {
					yield* emitEnvelope(
						successEnvelope({
							command: 'fork.advance-checkpoint',
							data: {
								stack: ctx.stack,
								wouldAdvanceCount: parsedCount,
								rpcUrl: ctx.rpcUrl,
							},
							elapsedMs: Date.now() - startedAt,
							dryRun: true,
						}),
					);
				} else {
					yield* Console.log(
						`would advance ${parsedCount} checkpoint${parsedCount === 1 ? '' : 's'} against ${ctx.rpcUrl} — dry run`,
					);
				}
				return;
			}
			const client = makeForkClient(ctx);
			const advances: Array<{ checkpointSequenceNumber: number; timestampMs: number }> = [];
			for (let i = 0; i < parsedCount; i++) {
				const resp = yield* wrapForkRpc(
					'fork advance-checkpoint: AdvanceCheckpoint',
					() => client.forkingService.advanceCheckpoint({}).response,
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
			if (useJson) {
				yield* emitEnvelope(
					successEnvelope({
						command: 'fork.advance-checkpoint',
						data: body,
						elapsedMs: Date.now() - startedAt,
					}),
				);
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
			const startedAt = Date.now();
			const useJson = jsonModeEnabled(json);
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
			const initial = yield* wrapForkRpc('fork replay-to: GetStatus', () =>
				client.forkingService.getStatus({}).response,
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
				if (useJson) {
					yield* emitEnvelope(
						successEnvelope({
							command: 'fork.replay-to',
							data: body,
							elapsedMs: Date.now() - startedAt,
						}),
					);
					return;
				}
				yield* Console.log(
					`fork replay-to: no-op — already at checkpoint ${current} (>= target ${parsedTarget})`,
				);
				return;
			}
			let advanced = 0;
			while (current < parsedTarget) {
				const resp = yield* wrapForkRpc(
					`fork replay-to: AdvanceCheckpoint at ${current}/${parsedTarget}`,
					() => client.forkingService.advanceCheckpoint({}).response,
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
			if (useJson) {
				yield* emitEnvelope(
					successEnvelope({
						command: 'fork.replay-to',
						data: body,
						elapsedMs: Date.now() - startedAt,
					}),
				);
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
			const startedAt = Date.now();
			const useJson = jsonModeEnabled(json);
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
			if (useJson) {
				yield* emitEnvelope(
					successEnvelope({
						command: 'fork.seed.list',
						data: body,
						elapsedMs: Date.now() - startedAt,
					}),
				);
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
		dryRun: Flag.boolean('dry-run').pipe(
			Flag.withDescription(
				'Same as a normal verify but never returns a non-zero exit even on mismatch (compare-only)',
			),
			Flag.withDefault(false),
		),
	},
	({ upstream, checkpoint, addresses, objects, stack, json, dryRun }) =>
		Effect.gen(function* () {
			const startedAt = Date.now();
			const useJson = jsonModeEnabled(json);
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
				if (useJson) {
					yield* emitEnvelope(
						successEnvelope({
							command: 'fork.seed.diff',
							data: body,
							elapsedMs: Date.now() - startedAt,
							...(dryRun ? { dryRun: true } : {}),
						}),
					);
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
			if (useJson) {
				if (match || dryRun) {
					yield* emitEnvelope(
						successEnvelope({
							command: 'fork.seed.diff',
							data: body,
							elapsedMs: Date.now() - startedAt,
							...(dryRun ? { dryRun: true } : {}),
						}),
					);
				} else {
					// Mismatch outside dry-run — emit error envelope with
					// the dedicated EX_SEED_MISMATCH exit code so CI can
					// gate on this specific failure mode.
					yield* emitEnvelope({
						schemaVersion: 1,
						ok: false,
						command: 'fork.seed.diff',
						error: {
							code: 'SEED_MISMATCH',
							exitCode: EX_SEED_MISMATCH,
							message: 'fork seed diff: configurations differ',
							context: { diff: body },
						},
						elapsedMs: Date.now() - startedAt,
					});
				}
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
			if (!match && !dryRun) {
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
// Cache-entry shape + walks moved to
// `engine/sui-fork/cache-inventory.ts`. CC-8 — `prune.ts:maybePruneForkCache`
// reuses the same helpers.

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
