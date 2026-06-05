// `--warm` boot-cache e2e — REAL docker, minimal stack.
//
// The warm boot cache (`devstack up --warm`) captures a baseline snapshot
// after the FIRST good cold boot and, on a later boot with the same graph key,
// RESTORES that baseline instead of cold-booting. Runtime invalidators
// (artifact cache misses, Docker image builds, container recreates) decide
// whether the restored baseline must be captured again after acquire.
//
// The three cases this file pins, all against the SAME persisted stack root so
// boot 2/3 observe boot 1's on-disk baseline + sidecar:
//
//   1. COLD → CAPTURE: a fresh stack with warm enabled and no prior baseline
//      cold-boots and, once up, writes `<stackRoot>/warm-baseline.json` (a
//      non-empty fingerprint) and lands the `warm-baseline` snapshot in the
//      catalog.
//   2. WARM → RESTORE: a second boot with the SAME inputs restores the
//      baseline — proven by a chain marker that ONLY boot 1 minted being
//      present after boot 2 with NO fresh deploy, AND the sidecar `capturedAt`
//      being byte-for-byte unchanged (no recapture happened).
//   3. RUNTIME INVALIDATION → RECAPTURE: mutating a watched Move source keeps
//      the graph key stable, restores the baseline, then makes
//      CacheService.publish produce a new artifact; that dirty signal advances
//      `capturedAt`.
//
// ─────────────────────────────────────────────────────────────────────────────
// HARNESS NOTE (load-bearing — read before editing):
//
// The warm hooks live INLINE in `cli/wirings/up.ts:runUpLive` — a warm-restore
// closure passed as `superviseStackEffect`'s `beforeInitialAcquire`, and a
// baseline-capture closure passed as its `withinScope`. The e2e boot harness
// `runBoot` (boot-config-impl.ts) drives `supervise()` DIRECTLY with its own
// ready-loop and a differently-shaped `withinScope: (BootScopeContext) => …`
// test callback; it never routes through `up.ts`. So this file drives warm
// through a `warm` option on `runBoot` that runs the SAME `up.ts` warm hook
// bodies. The contract the threading must honor:
//   - `runBoot({ ..., warm: {} })` runs the warm-restore hook before the
//     initial acquire and the baseline-capture hook after the stack is up,
//     using `computeWarmFingerprint`/`read|writeWarmBaseline`/the snapshot
//     orchestrator — i.e. the EXACT closures `up.ts` already runs.
//   - the boot's `withinScope` test callback still fires after the stack is up.
// ─────────────────────────────────────────────────────────────────────────────

import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Effect } from 'effect';
import { Transaction } from '@mysten/sui/transactions';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { account, defineDevstack, localPackage, sui, wallet } from '../../src/index.ts';
import { readStackEngine, type Stack } from '../../src/api/define-devstack.ts';
import {
	WARM_BASELINE_SIDECAR_FILE,
	type WarmBaselineSidecar,
} from '../../src/orchestrators/warm/baseline.ts';
import { WARM_BASELINE_SNAPSHOT_ID } from '../../src/orchestrators/warm/fingerprint.ts';
import {
	dockerReachable,
	pruneManagedImagesForApp,
	removeManagedContainersForAppStack,
} from './docker-prune.ts';
import { runBoot } from './boot-config-impl.ts';
import { findResolved, getSuiBalance, suiClientOf } from './snapshot-matrix/clients.ts';

const SUI_COIN_TYPE = '0x2::sui::SUI';
const MARKER_MIST = 100_000_000n; // 0.1 SUI

// ─────────────────────────────────────────────────────────────────────────────
// Docker gate — identical to snapshot-restore-matrix.test.ts. The
// `DEVSTACK_RUN_E2E` opt-in is enforced by vitest.config.ts (it excludes
// `test/e2e/**` unless `DEVSTACK_RUN_E2E=1`), so the file-level gate here is
// Docker-only: a missing docker daemon early-returns the `it` as a no-op.
// ─────────────────────────────────────────────────────────────────────────────

// Defensively clear any leaked image/source override env so the stack behavior
// stays stable across the three boots. The graph key no longer hashes env vars,
// but these overrides still feed Docker/source decisions during acquire.
const ensureCleanImageEnv = (): void => {
	delete process.env.WALRUS_CARGO_IMAGE_OVERRIDE;
	delete process.env.SEAL_CARGO_IMAGE_OVERRIDE;
	delete process.env.SEAL_MOVE_SOURCE_OVERRIDE;
	delete process.env.DEVSTACK_SUI_FORK_IMAGE;
};

const HERE = dirname(fileURLToPath(import.meta.url));
// warm-cache.test.ts -> e2e -> test -> devstack -> packages -> repo root
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const GREETING_SOURCE = resolve(REPO_ROOT, 'examples', 'fork-greeting', 'move', 'greeting');

// ─────────────────────────────────────────────────────────────────────────────
// Minimal warm-capable stack: sui localnet + the `greeting` local package
// (a single tiny Move module, published by an ephemeral account). No walrus /
// seal / deepbook — warm capture/restore is subsystem-agnostic (it is just a
// snapshot of the whole stack root + managed containers), so the cheapest real
// stateful stack suffices and keeps the per-boot wall-clock low.
// ─────────────────────────────────────────────────────────────────────────────

const STACK_NAME = 'warm-cache';

const buildWarmStack = (sourcePath: string): Stack => {
	const localnet = sui();
	const publisher = account('publisher', {
		kind: 'ephemeral',
		funding: [{ coin: 'sui', amount: 1_000_000_000_000n }],
	});
	const greeting = localPackage('greeting', { sourcePath, publisher });
	const devWallet = wallet({ accounts: [publisher] });
	return defineDevstack({
		members: [localnet, publisher, greeting, devWallet],
		stackName: STACK_NAME,
	});
};

// ─────────────────────────────────────────────────────────────────────────────
// A throwaway Move source tree this test can mutate without touching the
// checked-in example. Boot 3 edits a watched `.move` file under the same
// graph, which makes the artifact cache produce and the warm tracker recapture.
// ─────────────────────────────────────────────────────────────────────────────

const seedMoveSource = (): string => {
	const sourcePath = mkdtempSync(join(tmpdir(), 'warm-cache-move-'));
	cpSync(GREETING_SOURCE, sourcePath, { recursive: true });
	return sourcePath;
};

// ─────────────────────────────────────────────────────────────────────────────
// Sidecar IO. The sidecar is plain JSON under `<runtimeRoot>/stacks/<stack>/`
// (the substrate stack root — `stackSubpath(root, stack)`, app/chain are NOT in
// the path). Read it straight off disk so assertions stay simple.
// ─────────────────────────────────────────────────────────────────────────────

const stackRootFor = (runtimeRoot: string): string => join(runtimeRoot, 'stacks', STACK_NAME);

const readSidecar = (runtimeRoot: string): WarmBaselineSidecar | null => {
	try {
		const raw = readFileSync(join(stackRootFor(runtimeRoot), WARM_BASELINE_SIDECAR_FILE), 'utf8');
		return JSON.parse(raw) as WarmBaselineSidecar;
	} catch {
		return null;
	}
};

/** Poll for a valid (non-empty fingerprint) sidecar with a bounded wait. Warm
 *  capture runs as the boot's warm `withinScope`, which completes before
 *  `runBoot` resolves, but the on-disk flush is observed off the Effect, so a
 *  short poll de-flakes the read. */
const pollSidecar = async (
	runtimeRoot: string,
	timeoutMs = 30_000,
): Promise<WarmBaselineSidecar> => {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const sidecar = readSidecar(runtimeRoot);
		if (sidecar !== null && typeof sidecar.fingerprint === 'string' && sidecar.fingerprint !== '') {
			return sidecar;
		}
		if (Date.now() >= deadline) {
			throw new Error(
				`warm sidecar never appeared under ${stackRootFor(runtimeRoot)} in ${timeoutMs}ms`,
			);
		}
		await new Promise((r) => setTimeout(r, 500));
	}
};

// ─────────────────────────────────────────────────────────────────────────────
// Chain marker — the restore-vs-coldboot oracle for case 2.
//
// `publisher` is the resolved ephemeral account (key `account/publisher#N`),
// whose `signAndExecute` routes through the in-Effect address-lease broker (so
// it must run INSIDE the boot scope). The marker is a SUI transfer to a
// brand-new recipient address: that recipient is funded ONLY on the chain that
// ran the transfer. Mint it on boot 1 BEFORE the warm baseline is captured, so:
//   - a true RESTORE on boot 2 brings boot 1's chain state back → recipient
//     still funded.
//   - a cold re-boot on boot 2 starts from fresh genesis → recipient empty.
// ─────────────────────────────────────────────────────────────────────────────

interface PublisherLite {
	readonly address: string;
	readonly signAndExecute: (tx: Uint8Array) => Effect.Effect<{ readonly $kind: string }, unknown>;
}

const publisherOf = (ctx: import('./boot-config-impl.ts').BootScopeContext): PublisherLite =>
	findResolved(ctx, /^account\/publisher#\d+$/) as PublisherLite;

/** Transfer `MARKER_MIST` SUI from `publisher` to a fresh recipient and return
 *  the recipient address. Built with the harness's gRPC client, signed +
 *  executed via the account's lease-brokered `signAndExecute`. */
const mintChainMarker = (
	ctx: import('./boot-config-impl.ts').BootScopeContext,
): Effect.Effect<string, unknown> =>
	Effect.gen(function* () {
		const client = suiClientOf(ctx);
		const publisher = publisherOf(ctx);
		// A fresh, never-funded recipient: a random 32-byte hex address so it
		// can never collide with a genesis account. Its only funding source is
		// the transfer below, so its balance is a clean oracle for "did boot 1's
		// chain state come back".
		const recipient = `0x${[...crypto.getRandomValues(new Uint8Array(32))]
			.map((b) => b.toString(16).padStart(2, '0'))
			.join('')}`;
		const txBytes = yield* Effect.promise(() => {
			const tx = new Transaction();
			tx.setSender(publisher.address);
			const coin = tx.coin({ balance: MARKER_MIST, type: SUI_COIN_TYPE, useGasCoin: true });
			tx.transferObjects([coin], tx.pure.address(recipient));
			return tx.build({ client });
		});
		const result = yield* publisher.signAndExecute(txBytes);
		if (result.$kind !== 'Transaction') {
			return yield* Effect.die(`mintChainMarker: transfer failed: ${JSON.stringify(result)}`);
		}
		for (let attempt = 0; attempt < 60; attempt += 1) {
			const balance = yield* Effect.promise(() => getSuiBalance(client, recipient));
			if (balance > 0n) return recipient;
			yield* Effect.sleep('500 millis');
		}
		return yield* Effect.die(
			`mintChainMarker: marker balance never became visible for ${recipient}`,
		);
	});

const BOOT_TIMEOUT = 1_800_000;

describe('warm boot cache — real services @e2e', () => {
	// Sweep the managed build/snapshot images this test's three boots minted
	// (all under `appName: STACK_NAME`). Label-scoped so it can only reap images
	// THIS test created, never the user's stacks.
	beforeAll(() => removeManagedContainersForAppStack(STACK_NAME, STACK_NAME));
	afterAll(() => {
		removeManagedContainersForAppStack(STACK_NAME, STACK_NAME);
		pruneManagedImagesForApp(STACK_NAME);
	});

	it(
		'cold→capture, warm→restore, change→recapture across three boots @e2e',
		async () => {
			const docker = dockerReachable();
			if (!docker.ok) {
				console.warn(`warm-cache: skipping — ${docker.detail}`);
				return;
			}
			ensureCleanImageEnv();

			// One persisted runtime + router root across all three boots so the
			// on-disk warm baseline + sidecar captured by boot 1 are observed by
			// boots 2 and 3 (a fresh tmpdir per boot would defeat the cache).
			const ident = STACK_NAME;
			const runtimeRoot = mkdtempSync(join(tmpdir(), 'warm-cache-runtime-'));
			const routerStateRoot = mkdtempSync(join(tmpdir(), 'warm-cache-router-'));
			const sourcePath = seedMoveSource();

			// ── Boot 1: COLD → CAPTURE ────────────────────────────────────────────
			// No prior baseline → warm-restore misses → cold boot. While the stack
			// is up, mint a chain marker, then warm captures the baseline AFTER the
			// marker (the warm capture is the LAST thing the warm `withinScope`
			// does, after the test `withinScope` returns).
			let markerRecipient = '';
			const boot1 = await runBoot({
				stack: readStackEngine(buildWarmStack(sourcePath)),
				appName: ident,
				stackName: ident,
				runtimeRoot,
				routerStateRoot,
				warm: {},
				withinScope: (ctx) =>
					Effect.gen(function* () {
						markerRecipient = yield* mintChainMarker(ctx);
					}),
			});
			expect(boot1.failures, 'boot 1 cold boot has no plugin failures').toEqual([]);
			expect(markerRecipient, 'boot 1 minted a chain marker').not.toBe('');

			// CASE 1 assertions: sidecar present with a non-empty fingerprint
			// pointing at the warm-baseline snapshot id. (The catalog-membership
			// half of case 1 is asserted in boot 2's `withinScope` below, which
			// lists the catalog while the warm-baseline snapshot is live — the warm
			// capture fires AFTER this test `withinScope` returns, so an in-scope
			// list here would race it.)
			const sidecar1 = await pollSidecar(runtimeRoot);
			expect(sidecar1.fingerprint, 'boot 1 wrote a non-empty fingerprint').toMatch(
				/^[a-f0-9]{64}$/,
			);
			expect(sidecar1.snapshotId, 'sidecar points at the warm-baseline snapshot').toBe(
				WARM_BASELINE_SNAPSHOT_ID,
			);

			// ── Boot 2: WARM → RESTORE ────────────────────────────────────────────
			// Same stack root, same graph key → the fingerprint matches the sidecar
			// → the warm-restore path runs before acquire instead of starting from a
			// fresh runtime root. Restore-vs-coldboot is asserted two ways:
			//   (a) the marker recipient minted on boot 1 is STILL funded — only a
			//       restore of boot 1's chain state brings it back; a cold re-boot
			//       loses it.
			//   (b) the sidecar `capturedAt` is byte-for-byte unchanged — a warm
			//       restore must NOT recapture, so the baseline + sidecar are
			//       untouched.
			let markerStillFunded = false;
			let boot2Catalog: ReadonlyArray<string> = [];
			const boot2 = await runBoot({
				stack: readStackEngine(buildWarmStack(sourcePath)),
				appName: ident,
				stackName: ident,
				runtimeRoot,
				routerStateRoot,
				warm: {},
				withinScope: (ctx) =>
					Effect.gen(function* () {
						// The warm-baseline snapshot boot 1 captured is restored into
						// THIS boot, so it is live in the catalog here — list it to
						// close case 1's catalog-membership assertion.
						boot2Catalog = (yield* ctx.snapshot.list).map((e) => e.id);
						const client = suiClientOf(ctx);
						markerStillFunded = yield* Effect.promise(async () => {
							const bal = await getSuiBalance(client, markerRecipient);
							return bal > 0n;
						});
					}),
			});
			expect(boot2.failures, 'boot 2 warm restore has no plugin failures').toEqual([]);

			// CASE 1 (catalog half): the warm-baseline snapshot landed in the catalog.
			expect(boot2Catalog, 'warm-baseline snapshot is in the catalog').toContain(
				WARM_BASELINE_SNAPSHOT_ID,
			);
			// CASE 2 (a): the restore re-funded boot 1's marker recipient.
			expect(
				markerStillFunded,
				'warm RESTORE re-funded boot 1’s marker recipient (a cold re-boot would not)',
			).toBe(true);
			// CASE 2 (b): no recapture — sidecar capturedAt + fingerprint unchanged.
			const sidecar2 = await pollSidecar(runtimeRoot);
			expect(sidecar2.capturedAt, 'warm restore did NOT recapture (capturedAt unchanged)').toBe(
				sidecar1.capturedAt,
			);
			expect(sidecar2.fingerprint, 'warm restore did NOT change the fingerprint').toBe(
				sidecar1.fingerprint,
			);

			// ── Boot 3: RUNTIME INVALIDATION → RECAPTURE ──────────────────────────
			// Mutate a watched Move source without changing the stack graph. Warm
			// restore should still happen, then the package artifact contentHash
			// changes, CacheService.publish produces, and the invalidation tracker
			// makes warm capture refresh the baseline sidecar.
			writeFileSync(
				join(sourcePath, 'sources', 'board.move'),
				`${readFileSync(join(sourcePath, 'sources', 'board.move'), 'utf8')}\n// warm recapture\n`,
			);

			const boot3 = await runBoot({
				stack: readStackEngine(buildWarmStack(sourcePath)),
				appName: ident,
				stackName: ident,
				runtimeRoot,
				routerStateRoot,
				warm: {},
				withinScope: () => Effect.void,
			});
			expect(boot3.failures, 'boot 3 recapture boot has no plugin failures').toEqual([]);

			// CASE 3 assertions: the graph key stayed stable, but runtime
			// invalidation forced a NEW capture.
			const sidecar3 = await pollSidecar(runtimeRoot);
			expect(sidecar3.fingerprint, 'same graph → same fingerprint').toBe(sidecar1.fingerprint);
			expect(sidecar3.capturedAt, 'recapture advanced capturedAt').toBeGreaterThan(
				sidecar1.capturedAt,
			);
		},
		BOOT_TIMEOUT * 3,
	);
});
