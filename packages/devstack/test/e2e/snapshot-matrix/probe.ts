// The snapshot/restore state-survival invariant, parameterized over a set
// of per-subsystem probes.
//
// For each probe, across two boots of the SAME runtime root with an offline
// restore between them:
//
//   boot 1: create S1 (assert exists) -> snapshot -> create S2 (assert exists)
//   wipe the live deploy cache -> offline restore
//   boot 2: assert S1 still exists, assert S2 is gone, create S3 (assert exists)
//
// S2-gone proves the rollback rolled back; S3 proves the stack is writable
// again after restore. The fresh actor keypair is shared across both boots
// and funded BEFORE the snapshot so its funding survives the restore.
//
// The live deploy cache is WIPED before the restore so survival cannot lean on
// the in-place preserve — every deploy id must come back from the cache the
// snapshot CAPTURED. That makes this the harder `snapshot -> wipe -> restore`
// lifecycle and proves the snapshot is self-contained.

import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { Effect } from 'effect';

import { readStackEngine } from '../../../src/api/define-devstack.ts';
import type { Stack } from '../../../src/index.ts';
import { runBoot } from '../boot-config-impl.ts';
import { makeEnv, type ProbeEnv } from './clients.ts';
import { restoreSnapshotOffline } from './offline-restore.ts';

export interface Probe<H = unknown> {
	readonly name: string;
	/** Create a durable, queryable piece of state for this subsystem. The
	 *  returned handle is stashed across boots and passed back to `exists`. */
	createState(env: ProbeEnv, label: string): Promise<H>;
	/** Does the state referenced by `handle` currently exist on chain/storage? */
	exists(env: ProbeEnv, handle: H): Promise<boolean>;
}

export interface ProbeOutcome {
	readonly probe: string;
	/** S1/S2 existed immediately after creation on boot 1 (sanity). */
	readonly s1Created: boolean;
	readonly s2Created: boolean;
	/** Post-restore (boot 2): the invariant. */
	readonly s1Survived: boolean;
	readonly s2RolledBack: boolean;
	readonly s3Writable: boolean;
}

export const runMatrix = async (params: {
	readonly app: string;
	readonly stack: string;
	readonly buildStack: () => Stack;
	readonly probes: ReadonlyArray<Probe>;
	readonly snapshotId: string;
	readonly useRealRouter?: boolean;
}): Promise<ReadonlyArray<ProbeOutcome>> => {
	const runtimeRoot = mkdtempSync(join(tmpdir(), 'snapshot-matrix-runtime-'));
	const routerStateRoot = mkdtempSync(join(tmpdir(), 'snapshot-matrix-router-'));
	const keypair = Ed25519Keypair.generate();
	const engine = readStackEngine(params.buildStack());

	const s1 = new Map<string, unknown>();
	const s2 = new Map<string, unknown>();
	const created = new Map<string, { s1: boolean; s2: boolean }>();

	// BOOT 1 — create S1, snapshot, create S2.
	await runBoot({
		stack: engine,
		appName: params.app,
		stackName: params.stack,
		runtimeRoot,
		routerStateRoot,
		useRealRouter: params.useRealRouter,
		withinScope: (ctx) =>
			Effect.gen(function* () {
				const env = yield* Effect.orDie(makeEnv(ctx, keypair, { fund: true }));
				for (const p of params.probes) {
					const h1 = yield* Effect.promise(() => p.createState(env, 'S1'));
					s1.set(p.name, h1);
					const e1 = yield* Effect.promise(() => p.exists(env, h1));
					console.log(`[snapshot-matrix] ${p.name} S1 created, exists=${e1}`);
					created.set(p.name, { s1: e1, s2: false });
				}
				// Let the chain durably checkpoint before the snapshot pauses +
				// commits the containers (captured-state consistency).
				yield* Effect.sleep('3 seconds');
				yield* Effect.orDie(ctx.snapshot.capture(params.snapshotId));
				console.log(`[snapshot-matrix] captured snapshot ${params.snapshotId}`);
				for (const p of params.probes) {
					const h2 = yield* Effect.promise(() => p.createState(env, 'S2'));
					s2.set(p.name, h2);
					const e2 = yield* Effect.promise(() => p.exists(env, h2));
					console.log(`[snapshot-matrix] ${p.name} S2 created, exists=${e2}`);
					const prev = created.get(p.name)!;
					created.set(p.name, { s1: prev.s1, s2: e2 });
				}
			}),
	});

	// Simulate a `wipe` between snapshot and restore: drop the LIVE deploy/mint
	// cache (`<stackRoot>/cache/`) so the restore CANNOT fall back to the
	// preserved live copy — it must recover every deploy id from the cache
	// CAPTURED into the snapshot. This exercises the harder `snapshot → wipe →
	// restore` lifecycle; if the ids (and thus every surface below) still
	// survive, the snapshot is genuinely self-contained, not just in-place
	// reusable. (See DEPLOY_CACHE_NAMESPACES — captured in capture.ts, preserved
	// in restore.ts.)
	const liveCachePath = join(runtimeRoot, 'stacks', params.stack, 'cache');
	if (!existsSync(liveCachePath)) {
		// Path drift would make the wipe a no-op, letting survival lean on the
		// in-place preserve instead of the captured cache — i.e. a false pass.
		throw new Error(`runMatrix: expected a live deploy cache to wipe at ${liveCachePath}`);
	}
	rmSync(liveCachePath, { recursive: true, force: true });

	// OFFLINE RESTORE — no supervisor is live between the two boots.
	await restoreSnapshotOffline({
		runtimeRoot,
		app: params.app,
		stack: params.stack,
		network: 'sui:local',
		snapshotId: params.snapshotId,
	});
	console.log('[snapshot-matrix] offline restore complete (live cache wiped first)');

	// BOOT 2 — assert S1 survived, S2 rolled back, S3 writable.
	const outcomes: ProbeOutcome[] = [];
	await runBoot({
		stack: engine,
		appName: params.app,
		stackName: params.stack,
		runtimeRoot,
		routerStateRoot,
		useRealRouter: params.useRealRouter,
		withinScope: (ctx) =>
			Effect.gen(function* () {
				// Re-fund the actor each boot: funding is per-session setup (the
				// actor needs SUI + WAL to operate), not a survival probe — the
				// probes' S1/S2/S3 state is what the invariant checks.
				const env = yield* Effect.orDie(makeEnv(ctx, keypair, { fund: true }));
				for (const p of params.probes) {
					const s1Survived = yield* Effect.promise(() => p.exists(env, s1.get(p.name)));
					const s2Present = yield* Effect.promise(() => p.exists(env, s2.get(p.name)));
					const h3 = yield* Effect.promise(() => p.createState(env, 'S3'));
					const s3Writable = yield* Effect.promise(() => p.exists(env, h3));
					const c = created.get(p.name)!;
					console.log(
						`[snapshot-matrix] ${p.name} post-restore: s1Survived=${s1Survived} s2RolledBack=${!s2Present} s3Writable=${s3Writable}`,
					);
					outcomes.push({
						probe: p.name,
						s1Created: c.s1,
						s2Created: c.s2,
						s1Survived,
						s2RolledBack: !s2Present,
						s3Writable,
					});
				}
			}),
	});
	return outcomes;
};
