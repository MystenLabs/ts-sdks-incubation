// `devstack fork seed <list|diff>` — list dumps on-disk meta.json's
// seed addresses+objects (pure fs); diff compares meta.json against a
// caller-supplied config snapshot (--upstream/--checkpoint/etc), exit 1
// on mismatch unless --dry-run.

/* eslint-disable @typescript-eslint/no-explicit-any */

import { Console, Effect, FileSystem, Option, Path } from 'effect';
import { Command, Flag } from 'effect/unstable/cli';
import { computeConfigHash, readForkMeta } from '../../../engine/sui-fork/meta.js';
import { failAlreadyReported } from '../../already-reported.js';
import { emitEnvelope, jsonModeEnabled, successEnvelope } from '../../envelope.js';
import { EX_SEED_MISMATCH } from '../../exit-codes.js';
import { resolveForkMetaPath, resolveStack } from '../../stack-resolution.js';
import { jsonFlag, stackFlag } from './_shared.js';

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

// `fork seed diff` — two modes: with `--upstream <name>` (+ optional
// checkpoint/addresses/objects) compare the supplied config; without
// flags, just print the on-disk hash for piping. Exit 1 on diff
// (unless --dry-run).
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

export const seedCommand = Command.make('seed').pipe(
	Command.withDescription('Inspect the per-stack fork seed manifest'),
	Command.withSubcommands([seedListCommand, seedDiffCommand]),
);
