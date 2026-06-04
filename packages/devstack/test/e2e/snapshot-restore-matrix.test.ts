// Snapshot/restore state-survival matrix — REAL local services.
//
// The invariant, run per stateful subsystem across two boots of the same
// runtime root with an OFFLINE restore between them:
//
//   boot 1: create S1 (assert exists) -> snapshot -> create S2 (assert exists)
//   offline restore (cache untarred from the SNAPSHOT's host-tree — self-contained)
//   boot 2: assert S1 survived, assert S2 is gone, create S3 (assert exists)
//   boot 3: wipe the live deploy cache, re-boot, assert each probe's S1 matches
//           its `orphansOnCacheLoss` expectation (cache-derived probes ORPHAN)
//
// Snapshots are self-contained (capture tars `cache/<ns>`; restore untars it as
// the SOLE source — no preserve-from-live), so the cross-machine restore works;
// that empty-live-cache shape is unit-covered in restore.test.ts. Same-machine
// survival alone here would not distinguish snapshot-supplied ids from a stale
// live cache, so the fail-loud third phase pins the OPPOSITE for the
// CACHE-DERIVED subsystems (walrus + vault-seal): wiping the live cache must make
// the deploy re-run with FRESH ids and orphan S1 (a LOUD divergence) — cache loss
// is never silently masked. Subsystems whose identity is NOT cache-derived (sui
// genesis-deterministic; deepbook S1 is a chain object id) are asserted to
// SURVIVE the wipe instead — see `Probe.orphansOnCacheLoss`.
//
// S2-gone proves the rollback actually rolled back; S3 proves the stack is
// writable again after a restore. This closes the gap that
// `private-content-boot.test.ts` marks DEFERRED ("snapshot save -> kill ->
// restore roundtrip across the full local services").
//
// Verified subsystems (real walrus + seal images, not stubs), all SURVIVING the
// restore: sui (chain coins/objects), deepbook (BalanceManager DEX state),
// walrus (a blob written before the snapshot reads back after), and the seal
// vault (a seal-encrypted blob — survives AND still decrypts). A separate test
// proves codegen output tracks the restored packageId across a restore.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Effect } from 'effect';
import { describe, expect, it } from 'vitest';

import { readStackEngine } from '../../src/api/define-devstack.ts';
import { runBoot } from './boot-config-impl.ts';
import { vaultPackageIdOf } from './snapshot-matrix/clients.ts';
import { restoreSnapshotOffline } from './snapshot-matrix/offline-restore.ts';
import { runMatrix } from './snapshot-matrix/probe.ts';
import { deepbookProbe } from './snapshot-matrix/probes/deepbook.ts';
import { suiProbe } from './snapshot-matrix/probes/sui.ts';
import { vaultSealProbe } from './snapshot-matrix/probes/vault-seal.ts';
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

// The package plugin's Codegenable is `aggregateOnly` (since the PR #18 codegen
// reshape): it no longer emits a standalone `package/<mvr>.ts` file but folds
// its `packageId: "0x…"` literal into the combined aggregate `config.ts`
// (bucket `config.ts`, under `config.packages.<name>.packageId`) — see
// src/plugins/package/codegen.ts (`aggregateOnly: true`, `bucket: 'config.ts'`)
// and the orchestrator's `if (decl.aggregateOnly === true) continue;` in
// src/orchestrators/codegen/service.ts. Read the packageId back from that
// aggregate file in the harness codegen output dir (`<runtimeRoot>/codegen`).
//
// This stack publishes exactly one local package (the vault — the codegen test
// builds the matrix stack with `deepbook: false`), and only `localPackage`
// contributes a `packages.*.packageId` entry (sui projects network entries,
// seal/account/walrus route to their own buckets), so `config.ts` carries a
// single `packageId:` literal == the vault's id.
const PACKAGE_ID_RE = /packageId:\s*['"](0x[0-9a-fA-F]+)['"]/;
const CONFIG_FILE = 'config.ts';

const readCodegenPackageId = (outputDir: string): string => {
	const file = join(outputDir, CONFIG_FILE);
	const m = PACKAGE_ID_RE.exec(readFileSync(file, 'utf8'));
	if (m) return m[1]!;
	throw new Error(`no packageId literal in codegen aggregate ${file}`);
};

// Simulate post-snapshot codegen drift: overwrite the emitted packageId with a
// sentinel. Codegen output lives OUTSIDE the runtime stack root, so a restore
// does not roll it back — boot 2's codegen cycle must regenerate it.
const corruptCodegenPackageId = (outputDir: string): void => {
	const p = join(outputDir, CONFIG_FILE);
	writeFileSync(
		p,
		readFileSync(p, 'utf8').replace(PACKAGE_ID_RE, 'packageId: "0xdead0000dead0000"'),
	);
};

describe('snapshot/restore matrix — real services @e2e', () => {
	// Codegen output is a pure projection of the deployed packageId — NOT
	// snapshot state. It lives OUTSIDE the runtime stack root (`<runtimeRoot>/
	// codegen` here; `<appRoot>/src/generated` in production), so a restore does
	// NOT roll it back. It "survives" instead because the package deploy cache
	// rides the snapshot's host-tree (self-contained) and is untarred on restore,
	// so the post-restore boot reuses the SAME packageId and the codegen cycle
	// re-emits identical bindings. This resolves the user-facing concern ("editing
	// move code updates codegen; a restore must bring it back") via package-id
	// stability rather than by capturing the generated files.
	//
	// Proof: emit codegen (packageId_1), snapshot, CORRUPT the on-disk packageId
	// (the restore can't fix it — it's outside the captured tree), restore, then
	// assert boot 2's codegen cycle regenerates packageId_1, healing the drift.
	it('codegen output tracks the restored packageId across snapshot/restore @e2e', async () => {
		const docker = dockerReachable();
		if (!docker.ok) {
			console.warn(`snapshot-restore-matrix: skipping — ${docker.detail}`);
			return;
		}
		ensureRealImages();

		const ident = 'snapshot-matrix-codegen';
		const runtimeRoot = mkdtempSync(join(tmpdir(), 'snapshot-matrix-codegen-runtime-'));
		const routerStateRoot = mkdtempSync(join(tmpdir(), 'snapshot-matrix-codegen-router-'));
		const engine = readStackEngine(buildMatrixStack({ deepbook: false, stackName: ident }));

		// Boot 1: the stack deploys the vault (packageId_1); after the snapshot
		// the codegen cycle emits bindings carrying packageId_1.
		let vaultPkg1 = '';
		const boot1 = await runBoot({
			stack: engine,
			appName: ident,
			stackName: ident,
			runtimeRoot,
			routerStateRoot,
			runCodegen: true,
			withinScope: (ctx) =>
				Effect.gen(function* () {
					vaultPkg1 = vaultPackageIdOf(ctx);
					yield* Effect.sleep('3 seconds');
					yield* Effect.orDie(ctx.snapshot.capture('codegen-checkpoint'));
				}),
		});
		const codegenDir = boot1.codegenRun?.outputDir;
		expect(codegenDir, 'boot 1 ran the codegen cycle').toBeDefined();
		expect(readCodegenPackageId(codegenDir!), 'codegen reflects the deployed packageId').toBe(
			vaultPkg1,
		);

		// Drift the generated bindings AFTER the snapshot. Codegen output is
		// outside the captured tree, so the restore cannot undo this.
		corruptCodegenPackageId(codegenDir!);
		expect(readCodegenPackageId(codegenDir!)).not.toBe(vaultPkg1);

		// Offline restore — the chain rolls back; the package deploy cache is
		// preserved, so the next boot reuses packageId_1.
		await restoreSnapshotOffline({
			runtimeRoot,
			app: ident,
			stack: ident,
			network: 'sui:local',
			snapshotId: 'codegen-checkpoint',
		});

		// Boot 2: the codegen cycle regenerates from the restored, stable
		// packageId_1 — healing the on-disk drift the restore left behind.
		const boot2 = await runBoot({
			stack: engine,
			appName: ident,
			stackName: ident,
			runtimeRoot,
			routerStateRoot,
			runCodegen: true,
			withinScope: () => Effect.void,
		});
		const codegenDir2 = boot2.codegenRun?.outputDir;
		expect(codegenDir2, 'boot 2 ran the codegen cycle').toBeDefined();
		expect(
			readCodegenPackageId(codegenDir2!),
			'codegen regenerated to the restored packageId',
		).toBe(vaultPkg1);
	}, 1_800_000);

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
			probes: [suiProbe, deepbookProbe, walrusProbe, vaultSealProbe],
			snapshotId: 'matrix-checkpoint',
			// walrus blob writes/reads go direct to the storage-node vhosts,
			// which only route through real Traefik (see walrusProbe).
			useRealRouter: true,
		});

		expect(outcomes.length).toBeGreaterThan(0);
		for (const o of outcomes) {
			expect(o.s1Created, `${o.probe}: S1 should exist when created`).toBe(true);
			expect(o.s2Created, `${o.probe}: S2 should exist when created`).toBe(true);
			expect(o.s1Survived, `${o.probe}: S1 should survive the restore`).toBe(true);
			expect(o.s2RolledBack, `${o.probe}: S2 should be gone after the restore`).toBe(true);
			expect(o.s3Writable, `${o.probe}: S3 should be creatable after the restore`).toBe(true);
			// Fail-loud teeth, scoped per probe. CACHE-DERIVED subsystems (walrus,
			// vault-seal — `orphansOnCacheLoss: true`) MUST orphan S1 when the live
			// deploy cache is wiped: the deploy re-runs with FRESH ids, so a silent
			// re-deploy that left S1 resolving would be a false pass — this is the
			// load-bearing loud-divergence property. Subsystems whose identity is
			// NOT cache-derived (sui is genesis-deterministic; deepbook's S1 is an
			// object id read directly off the chain) MUST instead SURVIVE the wipe
			// (`orphansOnCacheLoss: false`); asserting orphaning for them would be
			// wrong. Pinning each probe to `=== orphansOnCacheLoss` proves BOTH
			// directions and keeps the teeth from being silently weakened.
			expect(
				o.s1OrphanedAfterCacheWipe,
				o.orphansOnCacheLoss
					? `${o.probe}: cache-derived S1 should be ORPHANED (loud divergence) after the live cache is wiped`
					: `${o.probe}: non-cache-derived S1 should SURVIVE a live-cache wipe (its identity isn't minted from the cache)`,
			).toBe(o.orphansOnCacheLoss);
		}
		// Guard the property itself: the cache-loss loud-divergence teeth are only
		// meaningful if at least one probe actually exercises them. Require the two
		// cache-derived probes (walrus + vault-seal) to BE in the matrix and to have
		// orphaned — so a future probe-list edit can't silently drop the teeth.
		const orphaned = outcomes.filter((o) => o.orphansOnCacheLoss && o.s1OrphanedAfterCacheWipe);
		expect(
			orphaned.map((o) => o.probe).sort(),
			'cache-derived probes must prove orphaning on cache loss',
		).toEqual(['vault-seal', 'walrus']);
	}, 1_800_000);
});
