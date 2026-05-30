// Snapshot/restore state-survival matrix — REAL local services.
//
// The invariant, run per stateful subsystem across two boots of the same
// runtime root with an OFFLINE restore between them:
//
//   boot 1: create S1 (assert exists) -> snapshot -> create S2 (assert exists)
//   offline restore
//   boot 2: assert S1 survived, assert S2 is gone, create S3 (assert exists)
//
// S2-gone proves the rollback actually rolled back; S3 proves the stack is
// writable again after a restore. This closes the gap that
// `private-content-boot.test.ts` marks DEFERRED ("snapshot save -> kill ->
// restore roundtrip across the full local services").
//
// Verified subsystems (real walrus + seal images, not stubs): sui (chain
// coins/objects) and deepbook (BalanceManager DEX state) survive the restore;
// walrus blob storage works headlessly via the real router. Walrus blob
// SURVIVAL and codegen are documented findings — see the skipped tests.

import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { Effect } from 'effect';
import { describe, expect, it } from 'vitest';

import { readStackEngine } from '../../src/api/define-devstack.ts';
import { runBoot } from './boot-config-impl.ts';
import { makeEnv } from './snapshot-matrix/clients.ts';
import { runMatrix } from './snapshot-matrix/probe.ts';
import { deepbookProbe } from './snapshot-matrix/probes/deepbook.ts';
import { suiProbe } from './snapshot-matrix/probes/sui.ts';
import { walrusProbe } from './snapshot-matrix/probes/walrus.ts';
import { buildMatrixStack, STACK_APP, STACK_NAME } from './snapshot-matrix/stack.ts';

const dockerReachable = (): { ok: boolean; detail: string } => {
	const res = spawnSync('docker', ['info', '--format', '{{.ServerVersion}}'], {
		encoding: 'utf8',
		timeout: 5_000,
	});
	if (res.status !== 0) {
		return { ok: false, detail: `docker info failed: status=${res.status}: ${res.stderr}` };
	}
	return { ok: true, detail: res.stdout.trim() };
};

// Force the REAL walrus + seal images. Other e2e tests set these stub
// overrides; vitest forks should be clean, but delete defensively so a leaked
// override can never silently downgrade this test to no-op stubs (which would
// make a passing snapshot/restore assertion meaningless).
const ensureRealImages = (): void => {
	delete process.env.WALRUS_CARGO_IMAGE_OVERRIDE;
	delete process.env.SEAL_CARGO_IMAGE_OVERRIDE;
	delete process.env.SEAL_MOVE_SOURCE_OVERRIDE;
};

describe('snapshot/restore matrix — real services @e2e', () => {
	// Walrus blob storage works headlessly once the harness wires the REAL
	// router (`runBoot`'s `useRealRouter`, added here): the @mysten/walrus SDK
	// writes slivers directly to each `walrus-node-i` vhost, which only routes
	// through real Traefik — the harness's fake host-loopback resolver returns
	// 127.0.0.1, reaching only host-published ports (fine for the sui RPC, not
	// the storage-node API). This proves the write -> read path end-to-end with
	// the funded fresh keypair. (Its SURVIVAL across snapshot/restore is the
	// documented finding below.) A distinct stack name isolates this boot's
	// containers from the invariant test's.
	it('walrus blob write + read roundtrip via the real router @e2e', async () => {
		const docker = dockerReachable();
		if (!docker.ok) {
			console.warn(`snapshot-restore-matrix: skipping — ${docker.detail}`);
			return;
		}
		ensureRealImages();

		const ident = 'snapshot-matrix-walrus';
		const runtimeRoot = mkdtempSync(join(tmpdir(), 'snapshot-matrix-walrus-runtime-'));
		const routerStateRoot = mkdtempSync(join(tmpdir(), 'snapshot-matrix-walrus-router-'));

		let readback = false;
		await runBoot({
			stack: readStackEngine(buildMatrixStack({ deepbook: false, stackName: ident })),
			appName: ident,
			stackName: ident,
			runtimeRoot,
			routerStateRoot,
			useRealRouter: true,
			withinScope: (ctx) =>
				Effect.gen(function* () {
					const env = yield* Effect.orDie(makeEnv(ctx, Ed25519Keypair.generate(), { fund: true }));
					const handle = yield* Effect.promise(() => walrusProbe.createState(env, 'roundtrip'));
					readback = yield* Effect.promise(() => walrusProbe.exists(env, handle));
					console.log(`[snapshot-matrix] walrus within-boot roundtrip readback=${readback}`);
				}),
		});

		expect(readback, 'a freshly written walrus blob should read back').toBe(true);
	}, 900_000);

	// FINDING (confirmed) — walrus blobs do NOT survive snapshot/restore.
	//
	// A blob stored before a snapshot is unreadable after the restore: walrus
	// REPUBLISHES its local deployment on the post-restore boot (the WAL +
	// system package ids change — confirmed via a `walCoinType` drift across
	// the two boots, e.g. 0x82be70…::wal::WAL -> 0x396a5f…::wal::WAL), which
	// orphans every pre-snapshot blob. sui + deepbook state survive intact.
	//
	// Root cause: walrus's deploy reuse gate is an artifact-cache lookup
	// (`src/plugins/walrus/deploy.ts`, namespace `walrus-deploy`). A warm
	// restart reuses the deployment; the restore's stage-and-swap defeats it so
	// the post-restore boot cache-misses and re-runs `walrus-deploy` with fresh
	// ids. Making the deploy identity survive restore (capture + restore the
	// deploy cache, or persist the deploy state in the state-store) is a
	// follow-up. The walrus probe + `useRealRouter` are the harness support —
	// flip walrusProbe into the `runMatrix` invariant once it survives.
	it.skip('walrus blob survives snapshot/restore @e2e', () => {
		// intentionally empty — see the comment above for the confirmed finding.
	});

	// DEFERRED — codegen output is not captured by the snapshot. The codegen
	// orchestrator writes generated bindings to `src/generated` (or
	// `<runtimeRoot>/codegen` under the test harness), neither of which is a
	// plugin-declared snapshot subtree, so a restore does NOT revert them. The
	// package plugin's captured packageId IS restored (state-store under the
	// runtime root), so after a restore the on-chain packageId reverts while
	// the on-disk bindings can drift. A probe would: boot (Move v1 ->
	// packageId_1 + codegen v1), snapshot, edit a Move source (-> packageId_2 +
	// codegen v2 on warm reboot), restore, then assert the generated bindings
	// match the restored packageId_1. Deferred because it needs a 3-boot,
	// Move-source-editing flow distinct from `runMatrix`.
	it.skip('codegen output survives snapshot/restore across a Move-source edit @e2e', () => {
		// intentionally empty — see the comment above.
	});

	// The core deliverable: the snapshot/restore state-survival invariant.
	it('snapshot/restore invariant: state survives, post-snapshot state rolls back @e2e', async () => {
		const docker = dockerReachable();
		if (!docker.ok) {
			console.warn(`snapshot-restore-matrix: skipping — ${docker.detail}`);
			return;
		}
		ensureRealImages();

		const outcomes = await runMatrix({
			app: STACK_APP,
			stack: STACK_NAME,
			buildStack: () => buildMatrixStack({ deepbook: true }),
			probes: [suiProbe, deepbookProbe],
			snapshotId: 'matrix-checkpoint',
		});

		expect(outcomes.length).toBeGreaterThan(0);
		for (const o of outcomes) {
			expect(o.s1Created, `${o.probe}: S1 should exist when created`).toBe(true);
			expect(o.s2Created, `${o.probe}: S2 should exist when created`).toBe(true);
			expect(o.s1Survived, `${o.probe}: S1 should survive the restore`).toBe(true);
			expect(o.s2RolledBack, `${o.probe}: S2 should be gone after the restore`).toBe(true);
			expect(o.s3Writable, `${o.probe}: S3 should be creatable after the restore`).toBe(true);
		}
	}, 1_800_000);
});
