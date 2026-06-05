// The snapshot/restore state-survival invariant, parameterized over a set
// of per-subsystem probes.
//
// For each probe, across boots of the SAME runtime root with an offline
// restore between them:
//
//   boot 1: create S1 (assert exists) -> snapshot -> create S2 (assert exists)
//   offline restore (cache comes from the SNAPSHOT's host-tree — self-contained)
//   boot 2: assert S1 survived, S2 rolled back, S3 writable
//
// S2-gone proves the rollback rolled back; S3 proves the stack is writable
// again after restore. The fresh actor keypair is shared across both boots
// and funded BEFORE the snapshot so its funding survives the restore.
//
// Snapshots are SELF-CONTAINED: capture tars `cache/<ns>` into the artifact and
// restore untars it (the snapshot's cache is the SOLE source — no
// preserve-from-live). The cross-machine variant of this is exercised in
// restore.test.ts (rm the live cache, restore, survival holds). Survival alone
// here would not distinguish snapshot-supplied ids from a stale live cache, so
// the test's teeth are in a load-bearing THIRD phase: wipe the live deploy cache
// AFTER restore, re-boot, and check each probe's S1. For a CACHE-DERIVED
// subsystem (`Probe.orphansOnCacheLoss === true`: walrus + vault-seal) S1 must
// NO LONGER resolve — cache loss makes the deploy re-run with FRESH ids and
// orphan S1 (a LOUD divergence) rather than being silently masked. For a
// non-cache-derived subsystem (sui, deepbook) S1 legitimately survives. Surfaced
// as `s1OrphanedAfterCacheWipe` and asserted upstream as
// `s1OrphanedAfterCacheWipe === orphansOnCacheLoss`.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { Effect } from 'effect';

import { readStackEngine } from '../../../src/api/define-devstack.ts';
import type { Stack } from '../../../src/index.ts';
import { runBoot } from '../boot-config-impl.ts';
import { makeEnv, suiClientOf, type ProbeEnv } from './clients.ts';
import { restoreSnapshotOffline } from './offline-restore.ts';

export interface Probe<H = unknown> {
	readonly name: string;
	/** Is this subsystem's S1 IDENTITY derived from the live deploy cache?
	 *
	 *  This decides what the boot-3 fail-loud phase asserts (see `runMatrix`):
	 *  the contract is `s1OrphanedAfterCacheWipe === orphansOnCacheLoss`.
	 *
	 *  - `true`  — the subsystem's identity (the package/object ids its S1
	 *    references) is MINTED on deploy and cached. Wiping the live deploy
	 *    cache makes the deploy re-run with FRESH ids, so the pre-snapshot S1
	 *    no longer resolves — cache loss MUST orphan S1 (a LOUD divergence,
	 *    never silently masked). This is the load-bearing teeth of this test;
	 *    we require at least walrus + vault-seal to exhibit it.
	 *  - `false` — the subsystem's identity is NOT cache-derived, so losing the
	 *    cache legitimately does NOT orphan its S1 (asserting orphaning would
	 *    be wrong / flaky). See each probe def for the per-subsystem reason. */
	readonly orphansOnCacheLoss: boolean;
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
	/** Post-D1 fail-loud teeth (boot 3): after the restore-survival check,
	 *  the live deploy cache is WIPED and the stack re-booted. For a
	 *  CACHE-DERIVED subsystem the deploy re-runs with FRESH ids, so S1 must
	 *  NO LONGER resolve — i.e. cache loss diverges LOUD instead of being
	 *  silently masked. True == the orphaning was observed. The expected value
	 *  is per-probe (`Probe.orphansOnCacheLoss`): cache-derived probes MUST
	 *  orphan; non-cache-derived probes MUST survive (their identity isn't
	 *  minted from the cache). Asserted as
	 *  `s1OrphanedAfterCacheWipe === orphansOnCacheLoss` upstream. */
	readonly s1OrphanedAfterCacheWipe: boolean;
	/** Echoed from the probe def so the assertion is self-describing. */
	readonly orphansOnCacheLoss: boolean;
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
				// The capture bounce hard-rms + recreates every container (the
				// graceful-stop flush — NOT a survivable `docker pause`), recreating
				// the sui validator as a NEW process. Swap in the FRESH sui client
				// (`ctx.snapshot.capture` refreshed `ctx.resolvedValues` from the
				// post-resume registry) so a host-port change across the recreate
				// can't leave the probe calling a dead endpoint. The OTHER resolved
				// values are deliberately KEPT from the pre-capture `env`: the
				// actor was funded BEFORE the snapshot, and that funding (incl. its
				// WAL coin of the PRE-capture `walCoinType`) lives in the committed
				// chain state the resume boots on — re-reading walrus's post-resume
				// resolved value would pick up a re-minted WAL coin type the actor
				// holds zero of, breaking the storage-payment the blob write needs.
				const envAfter: ProbeEnv = { ...env, suiClient: suiClientOf(ctx) };
				for (const p of params.probes) {
					const h2 = yield* Effect.promise(() => p.createState(envAfter, 'S2'));
					s2.set(p.name, h2);
					const e2 = yield* Effect.promise(() => p.exists(envAfter, h2));
					console.log(`[snapshot-matrix] ${p.name} S2 created, exists=${e2}`);
					const prev = created.get(p.name)!;
					created.set(p.name, { s1: prev.s1, s2: e2 });
				}
			}),
	});

	// CROSS-MACHINE SIMULATION — wipe the LIVE deploy cache BEFORE the offline
	// restore so this runtime root looks like a FRESH CI runner (CI seeds on
	// runner A, restores on runner B with no live cache). Self-contained
	// snapshots make this work: the restore untars `cache/<ns>` from the
	// snapshot's host-tree (the SOLE source — restore does NOT preserve-from-
	// live), so the empty live cache is repopulated from the snapshot itself.
	// Boot 2 below then proves SURVIVAL holds (ids reused from the restored
	// cache, no orphaning) — covering the exact path that was failing in CI with
	// `cache-missing`. (The same empty-live-cache shape is also unit-covered in
	// restore.test.ts against the preflight + untar.)
	const liveCacheBeforeRestore = join(runtimeRoot, 'stacks', params.stack, 'cache');
	rmSync(liveCacheBeforeRestore, { recursive: true, force: true });
	console.log('[snapshot-matrix] live deploy cache wiped — simulating a fresh cross-machine runner');
	await restoreSnapshotOffline({
		runtimeRoot,
		app: params.app,
		stack: params.stack,
		network: 'sui:local',
		snapshotId: params.snapshotId,
	});
	console.log('[snapshot-matrix] offline restore complete (cache recovered from snapshot host-tree)');

	// BOOT 2 — assert S1 survived, S2 rolled back, S3 writable.
	const outcomes = new Map<string, ProbeOutcome>();
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
					outcomes.set(p.name, {
						probe: p.name,
						s1Created: c.s1,
						s2Created: c.s2,
						s1Survived,
						s2RolledBack: !s2Present,
						s3Writable,
						orphansOnCacheLoss: p.orphansOnCacheLoss,
						// Filled in by the fail-loud third phase below.
						s1OrphanedAfterCacheWipe: false,
					});
				}
			}),
	});

	// BOOT 3 — the load-bearing FAIL-LOUD phase. Post-D1 a plain restore-survival
	// proves nothing about self-containment (the live cache was reused), so the
	// teeth move to proving the OPPOSITE: cache loss must NOT be silently masked.
	// Wipe the live deploy cache (the dir a hard reset would drop), re-boot, and
	// check each probe's S1. For a CACHE-DERIVED subsystem (walrus, vault-seal —
	// `orphansOnCacheLoss: true`) the deploy re-runs with FRESH ids, orphaning
	// the pre-snapshot S1 objects: a silent re-deploy that left S1 resolving
	// would be a false pass. A NON-cache-derived subsystem (sui, deepbook —
	// `orphansOnCacheLoss: false`) legitimately keeps S1 resolving; the upstream
	// assertion pins each probe to its own expectation
	// (`s1OrphanedAfterCacheWipe === orphansOnCacheLoss`).
	const liveCachePath = join(runtimeRoot, 'stacks', params.stack, 'cache');
	rmSync(liveCachePath, { recursive: true, force: true });
	console.log('[snapshot-matrix] live deploy cache wiped — re-booting to prove loud divergence');
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
					const s1StillResolves = yield* Effect.promise(() => p.exists(env, s1.get(p.name)));
					const orphaned = !s1StillResolves;
					console.log(
						`[snapshot-matrix] ${p.name} after-cache-wipe: s1OrphanedAfterCacheWipe=${orphaned} (cache-derived=${p.orphansOnCacheLoss}, expected orphaned=${p.orphansOnCacheLoss})`,
					);
					const prev = outcomes.get(p.name)!;
					outcomes.set(p.name, { ...prev, s1OrphanedAfterCacheWipe: orphaned });
				}
			}),
	});

	return params.probes.map((p) => outcomes.get(p.name)!);
};
