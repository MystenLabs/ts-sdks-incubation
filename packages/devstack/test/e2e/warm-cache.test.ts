// `--warm` boot-cache e2e — REAL docker, minimal stack.
//
// The warm boot cache (`devstack up --warm`) captures a baseline snapshot
// after the FIRST good cold boot and, on a later boot with UNCHANGED inputs,
// RESTORES that baseline instead of cold-booting. A change to any
// fingerprinted input (config bytes, member set, options, a watched Move
// source, an image-override env var, the devstack version) invalidates the
// baseline and forces a fresh cold boot + recapture.
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
//   3. CHANGE INPUT → RECAPTURE: mutating a fingerprinted input (the config
//      file bytes — the PRIMARY fingerprint signal) between boots makes boot 3
//      treat the baseline as stale — the sidecar `fingerprint` changes and
//      `capturedAt` advances (a fresh cold boot + recapture).
//
// ─────────────────────────────────────────────────────────────────────────────
// HARNESS NOTE (load-bearing — read before editing):
//
// The warm hooks live INLINE in `cli/wirings/up.ts:runUpLive` — a warm-restore
// closure passed as `superviseStackEffect`'s `beforeInitialAcquire`, and a
// baseline-capture closure passed as its `withinScope`. The e2e boot harness
// `runBoot` (boot-config-impl.ts) drives `supervise()` DIRECTLY with its own
// ready-loop and a differently-shaped `withinScope: (BootScopeContext) => …`
// test callback; it never routes through `up.ts` and exposes no `warm` option,
// `appRoot`, or `configPath`. So this file drives warm through a `warm` option
// on `runBoot` (`{ appRoot, configPath }`) that runs the SAME `up.ts` warm
// hook bodies. That minimal harness threading is a one-shot SRC change the
// orchestrator must land before this file compiles — see the agent report's
// "src change needed" section. The contract the threading must honor:
//   - `runBoot({ ..., warm: { appRoot, configPath } })` runs the warm-restore
//     hook before the initial acquire and the baseline-capture hook after the
//     stack is up, using `computeWarmFingerprint`/`read|writeWarmBaseline`/the
//     snapshot orchestrator — i.e. the EXACT closures `up.ts` already runs.
//   - the boot's `withinScope` test callback still fires after the stack is up.
// ─────────────────────────────────────────────────────────────────────────────

import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Effect } from 'effect';
import { Transaction } from '@mysten/sui/transactions';
import { afterAll, describe, expect, it } from 'vitest';

import { account, defineDevstack, localPackage, sui, wallet } from '../../src/index.ts';
import { readStackEngine, type Stack } from '../../src/api/define-devstack.ts';
import {
	WARM_BASELINE_SIDECAR_FILE,
	type WarmBaselineSidecar,
} from '../../src/orchestrators/warm/baseline.ts';
import { WARM_BASELINE_SNAPSHOT_ID } from '../../src/orchestrators/warm/fingerprint.ts';
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

// Label-scoped image prune: removes ONLY the managed `devstack-build:*` /
// `devstack-snapshot:*` images this test's boots minted, scoped by
// `devstack.app=<app>` + `devstack.managed=true`. The app filter is the safety
// boundary — never tag-prefix, never unfiltered — so it can NEVER touch the
// user's other devstack images. Best-effort: swallow all failures so a missing
// docker or an empty match can't fail the suite.
const pruneManagedImagesForApp = (app: string): void => {
	try {
		spawnSync(
			'docker',
			[
				'image',
				'prune',
				'-f',
				'--filter',
				`label=devstack.app=${app}`,
				'--filter',
				'label=devstack.managed=true',
			],
			{ encoding: 'utf8', timeout: 60_000 },
		);
	} catch {
		// cleanup must never throw
	}
};

// Defensively clear any leaked image-override env so the warm fingerprint
// (which folds `*_CARGO_IMAGE_OVERRIDE` / `*_FORK_IMAGE` / `DEVSTACK_*_IMAGE`
// into the hash) is stable across the three boots and a stray override from a
// sibling test can't silently shift the fingerprint mid-file.
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

const buildWarmStack = (): Stack => {
	const localnet = sui();
	const publisher = account('publisher', {
		kind: 'ephemeral',
		funding: [{ coin: 'sui', amount: 1_000_000_000_000n }],
	});
	const greeting = localPackage('greeting', { sourcePath: GREETING_SOURCE, publisher });
	const devWallet = wallet({ accounts: [publisher] });
	return defineDevstack({
		members: [localnet, publisher, greeting, devWallet],
		stackName: STACK_NAME,
		// `warm` lives on DevstackOptions; the warm hooks read it as the
		// config-level default (the CLI `--warm` flag wins over it). Setting it
		// here arms warm for a programmatic boot with no CLI flag.
		warm: true,
	});
};

// ─────────────────────────────────────────────────────────────────────────────
// A throwaway config file the warm fingerprint can hash. The harness builds the
// stack PROGRAMMATICALLY (not by importing a config), but the warm fingerprint
// REQUIRES a readable `configPath` — it sha256s those bytes as the PRIMARY
// signal, and an unreadable config is a hard `WarmFingerprintError`. We seed a
// real file under a temp appRoot and point the warm option at it; case 3
// rewrites its bytes to invalidate the baseline via the primary signal.
// ─────────────────────────────────────────────────────────────────────────────

const seedConfig = (
	contents: string,
): { readonly appRoot: string; readonly configPath: string } => {
	const appRoot = mkdtempSync(join(tmpdir(), 'warm-cache-app-'));
	mkdirSync(appRoot, { recursive: true });
	const configPath = join(appRoot, 'devstack.config.ts');
	writeFileSync(configPath, contents);
	return { appRoot, configPath };
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
const pollSidecar = async (runtimeRoot: string, timeoutMs = 30_000): Promise<WarmBaselineSidecar> => {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const sidecar = readSidecar(runtimeRoot);
		if (sidecar !== null && typeof sidecar.fingerprint === 'string' && sidecar.fingerprint !== '') {
			return sidecar;
		}
		if (Date.now() >= deadline) {
			throw new Error(`warm sidecar never appeared under ${stackRootFor(runtimeRoot)} in ${timeoutMs}ms`);
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
		return recipient;
	});

const BOOT_TIMEOUT = 1_800_000;

describe('warm boot cache — real services @e2e', () => {
	// Sweep the managed build/snapshot images this test's three boots minted
	// (all under `appName: STACK_NAME`). Label-scoped so it can only reap images
	// THIS test created, never the user's stacks.
	afterAll(() => pruneManagedImagesForApp(STACK_NAME));

	it('cold→capture, warm→restore, change→recapture across three boots @e2e', async () => {
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
		const { appRoot, configPath } = seedConfig('export default { stackName: "warm-cache" }');

		// ── Boot 1: COLD → CAPTURE ────────────────────────────────────────────
		// No prior baseline → warm-restore misses → cold boot. While the stack
		// is up, mint a chain marker, then warm captures the baseline AFTER the
		// marker (the warm capture is the LAST thing the warm `withinScope`
		// does, after the test `withinScope` returns).
		let markerRecipient = '';
		const boot1 = await runBoot({
			stack: readStackEngine(buildWarmStack()),
			appName: ident,
			stackName: ident,
			runtimeRoot,
			routerStateRoot,
			warm: { appRoot, configPath },
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
		expect(sidecar1.fingerprint, 'boot 1 wrote a non-empty fingerprint').toMatch(/^[a-f0-9]{64}$/);
		expect(sidecar1.snapshotId, 'sidecar points at the warm-baseline snapshot').toBe(
			WARM_BASELINE_SNAPSHOT_ID,
		);

		// ── Boot 2: WARM → RESTORE ────────────────────────────────────────────
		// Same stack root, same inputs → the fingerprint matches the sidecar →
		// the warm-restore path runs INSTEAD of a cold boot. Restore-vs-coldboot
		// is asserted two ways:
		//   (a) the marker recipient minted on boot 1 is STILL funded — only a
		//       restore of boot 1's chain state brings it back; a cold re-boot
		//       loses it.
		//   (b) the sidecar `capturedAt` is byte-for-byte unchanged — a warm
		//       restore must NOT recapture, so the baseline + sidecar are
		//       untouched.
		let markerStillFunded = false;
		let boot2Catalog: ReadonlyArray<string> = [];
		const boot2 = await runBoot({
			stack: readStackEngine(buildWarmStack()),
			appName: ident,
			stackName: ident,
			runtimeRoot,
			routerStateRoot,
			warm: { appRoot, configPath },
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

		// ── Boot 3: CHANGE INPUT → RECAPTURE ──────────────────────────────────
		// Perturb the PRIMARY fingerprint signal — the config file bytes — while
		// holding the identity stack constant (`ident`) so boot 3 stays on the
		// SAME stack root and observes boot 1's now-stale baseline. Identity
		// selects the stack root; the fingerprint selects baseline validity —
		// they are deliberately decoupled, so a config-byte change is the clean
		// way to invalidate without relocating the root.
		writeFileSync(configPath, 'export default { stackName: "warm-cache", network: "localnet" }');

		const boot3 = await runBoot({
			stack: readStackEngine(buildWarmStack()),
			appName: ident,
			stackName: ident,
			runtimeRoot,
			routerStateRoot,
			warm: { appRoot, configPath },
			withinScope: () => Effect.void,
		});
		expect(boot3.failures, 'boot 3 recapture boot has no plugin failures').toEqual([]);

		// CASE 3 assertions: the stale baseline was rejected — a fresh cold boot
		// recaptured. The fingerprint changed (config bytes differ) and
		// capturedAt advanced (a NEW capture happened).
		const sidecar3 = await pollSidecar(runtimeRoot);
		expect(sidecar3.fingerprint, 'changed config bytes → new fingerprint').not.toBe(
			sidecar1.fingerprint,
		);
		expect(sidecar3.capturedAt, 'recapture advanced capturedAt').toBeGreaterThan(
			sidecar1.capturedAt,
		);
	}, BOOT_TIMEOUT * 3);
});
