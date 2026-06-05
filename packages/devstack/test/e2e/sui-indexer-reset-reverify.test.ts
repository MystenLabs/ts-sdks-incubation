// E2E regression guard — the indexer-db sidecar's NATIVE configHash drives
// reset-on-regenesis / restore-on-restart, no marker/dropdb machinery.
//
// The configHash token folds TWO re-genesis-determining inputs: the
// validator's pre-boot DISPOSITION (`chain=present`/`fresh`) AND its resolved
// image ref (`img=<tag-or-digest>`). The disposition cases (cold/restart/
// kill-137/rm -f) are exercised here against real docker; the image-ref fold
// (an image bump → different token → recreate) is proven in the unit suite
// (`test/plugins/sui/local-indexer.test.ts`) since swapping the vendored
// sui-tools image in an e2e is prohibitively heavy. These assertions match the
// `chain=` segment via `toContain` (the `img=` segment is asserted present but
// not pinned to a literal, since the resolved tag is content-addressed).
//
// Local-only: test/e2e is opt-in via DEVSTACK_RUN_E2E and is NOT run in CI; run
// it with `pnpm test:e2e`. Boots the full substrate against real docker:
//   (a) cold boot: default sui() boots; the indexer-db sidecar carries a
//       `devstack.config-hash` label (its disposition+image-keyed token).
//   (b) restore-on-restart: a clean re-boot RESUMES the sidecar (same container
//       id; config-hash label unchanged) — no recreate.
//   (c) reset-on-crash-recreate: `docker kill` the validator (SIGKILL → exit
//       137) → re-boot → the runtime recreates the 137-validator (fresh layer →
//       re-genesis → NEW chain); the disposition read sees present+137 →
//       `chain=fresh` ≠ the live `chain=present` label, so the sidecar is
//       RECREATED (new container id), the indexer re-indexes — no stale rows.
//       This is the gap presence-only keying missed: a SIGKILLed validator is
//       still PRESENT, yet the runtime re-genesises it.
//   (d) reset-on-regenesis: `docker rm -f` the validator → re-boot → validator
//       re-genesises a NEW chain; the sidecar's configHash now differs (the
//       post-rm boot reads the validator absent → `chain=fresh`), so the
//       sidecar is RECREATED (new container id), the indexer re-indexes.

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Effect } from 'effect';
import { describe, expect, it } from 'vitest';

import { defineDevstack, readStackEngine } from '../../src/api/define-devstack.ts';
import { sui } from '../../src/plugins/sui/index.ts';
import { runBoot, type BootScopeContext } from './boot-config-impl.ts';
import { dockerSpawnSync } from './docker-prune.ts';

const APP = 'sui-native-cfghash';
const STACK = 'native1';

const VALIDATOR = `devstack-${APP}-${STACK}-sui-validator`;
const SIDECAR = `${APP}-${STACK}-indexer-db`;

const dockerOk = (): boolean =>
	dockerSpawnSync(['info', '--format', '{{.ServerVersion}}'], { timeout: 5_000 }).status === 0;

const suiChainOf = (ctx: BootScopeContext): string =>
	(findSui(ctx) as { readonly chain: string }).chain;

const findSui = (ctx: BootScopeContext): unknown => {
	for (const [key, value] of ctx.resolvedValues) {
		if (/^sui#\d+$/.test(key)) return value;
	}
	throw new Error(`no sui#N in [${[...ctx.resolvedValues.keys()].join(', ')}]`);
};

/** `docker inspect -f '<fmt>' <name>` → trimmed stdout, or null on miss. */
const inspectField = (name: string, fmt: string): string | null => {
	const res = dockerSpawnSync(['inspect', '-f', fmt, name], { timeout: 15_000 });
	return res.status === 0 ? res.stdout.trim() : null;
};

const sidecarConfigHash = (): string | null =>
	inspectField(SIDECAR, '{{ index .Config.Labels "devstack.config-hash" }}');
const sidecarId = (): string | null => inspectField(SIDECAR, '{{ .Id }}');

describe('sui indexer-db native configHash reset/restore @e2e', () => {
	it('cold→restart resumes; kill-137 + rm -f both re-genesise + recreate the sidecar @e2e', async () => {
		if (!dockerOk()) {
			console.warn('sui-native-cfghash: skipping — docker unreachable');
			return;
		}
		const runtimeRoot = mkdtempSync(join(tmpdir(), 'sui-native-cfghash-rt-'));
		const routerStateRoot = mkdtempSync(join(tmpdir(), 'sui-native-cfghash-router-'));
		const engine = readStackEngine(defineDevstack({ members: [sui()], stackName: STACK }));

		try {
			// (a) Cold boot — validator + indexer-db sidecar up; GraphQL answers
			// (the sui ready-probe gates on GraphQL when the indexer is on).
			let chain1 = '';
			const boot1 = await runBoot({
				stack: engine,
				appName: APP,
				stackName: STACK,
				runtimeRoot,
				routerStateRoot,
				withinScope: (ctx) =>
					Effect.sync(() => {
						chain1 = suiChainOf(ctx);
					}),
			});
			expect(boot1.failures, `boot 1: ${JSON.stringify(boot1.failures)}`).toHaveLength(0);
			expect(chain1.length).toBeGreaterThan(0);
			const cfg1 = sidecarConfigHash();
			const id1 = sidecarId();
			// (a) the sidecar carries a config-hash label and an id; the token
			// folds BOTH the chain disposition AND the resolved validator image ref.
			expect(cfg1, 'sidecar config-hash label after cold boot').not.toBeNull();
			expect(cfg1).toContain('chain=');
			expect(cfg1, 'config-hash folds the validator image ref').toContain('img=');
			expect(id1, 'sidecar id after cold boot').not.toBeNull();

			// boot 2 — the FIRST restart after a cold (validator-absent) boot. The
			// cold boot stamped `chain=fresh` (no validator existed pre-sidecar);
			// this restart finds the validator PRESENT → `chain=present`, so the
			// sidecar recreates ONCE to settle on the steady-state token. This is
			// the known one-time re-index after a fresh start (see report) — NOT a
			// per-restart reset.
			const boot2 = await runBoot({
				stack: engine,
				appName: APP,
				stackName: STACK,
				runtimeRoot,
				routerStateRoot,
				withinScope: () => Effect.void,
			});
			expect(boot2.failures, `boot 2: ${JSON.stringify(boot2.failures)}`).toHaveLength(0);
			const cfg2 = sidecarConfigHash();
			const id2 = sidecarId();
			// Steady-state disposition is `chain=present`; the full token also
			// carries the (content-addressed) `img=` segment, so match by contains.
			expect(cfg2, 'steady-state config-hash after first restart').toContain(
				'indexer-db|chain=present',
			);
			expect(cfg2, 'steady-state config-hash carries the image ref').toContain('img=');

			// (b) Restore-on-restart (STEADY STATE) — a clean re-boot now RESUMES
			// the sidecar: validator present → `chain=present` matches the live
			// label → same container id, label unchanged, rows preserved.
			const boot3 = await runBoot({
				stack: engine,
				appName: APP,
				stackName: STACK,
				runtimeRoot,
				routerStateRoot,
				withinScope: () => Effect.void,
			});
			expect(boot3.failures, `boot 3: ${JSON.stringify(boot3.failures)}`).toHaveLength(0);
			expect(sidecarConfigHash(), 'config-hash unchanged on steady restart').toBe(cfg2);
			expect(sidecarId(), 'sidecar RESUMED (same container id) on steady restart').toBe(id2);
			const idResumed = sidecarId();

			// (c) Reset-on-crash-recreate — record a real SIGKILL/137 on the
			// PERSISTED validator (what an OOM / `docker kill` on a live stack
			// leaves behind). `runBoot` returns with the validator scope-stopped
			// (graceful exit), so START it, then KILL it: the container stays
			// PRESENT but its last exit is 137 → the runtime's `decideRunAction`
			// recreates the `on-failure` container → fresh writable layer →
			// re-genesis → NEW chain. Presence-only keying would have RESUMED
			// stale rows here; disposition keying reads present+137 → `chain=fresh`
			// ≠ the live `chain=present` label → RECREATE the sidecar.
			const start = dockerSpawnSync(['start', VALIDATOR], { timeout: 30_000 });
			expect(start.status, `docker start validator: ${start.stderr}`).toBe(0);
			const kill = dockerSpawnSync(['kill', '--signal=KILL', VALIDATOR], { timeout: 30_000 });
			expect(kill.status, `docker kill validator: ${kill.stderr}`).toBe(0);
			// Prove the validator really exited 137 before re-booting.
			expect(inspectField(VALIDATOR, '{{ .State.ExitCode }}'), 'validator exit code').toBe('137');

			let chainKilled = '';
			const bootKilled = await runBoot({
				stack: engine,
				appName: APP,
				stackName: STACK,
				runtimeRoot,
				routerStateRoot,
				withinScope: (ctx) =>
					Effect.sync(() => {
						chainKilled = suiChainOf(ctx);
					}),
			});
			expect(
				bootKilled.failures,
				`boot after kill-137: ${JSON.stringify(bootKilled.failures)}`,
			).toHaveLength(0);
			expect(chainKilled.length).toBeGreaterThan(0);
			// New chain (re-genesis) + RECREATED sidecar (new id) → empty DB → the
			// embedded indexer re-indexes; no stale rows against the new chain. The
			// present+137 disposition read at sidecar-create stamped `chain=fresh`
			// (≠ the live `chain=present` label → recreate); the label settles back
			// to `chain=present` on the NEXT clean boot (the known one-time double).
			expect(chainKilled, 'kill-137 minted a NEW chain (re-genesis)').not.toBe(chain1);
			expect(
				sidecarConfigHash(),
				'config-hash is `chain=fresh` after the 137 crash-recreate',
			).toContain('indexer-db|chain=fresh');
			expect(
				sidecarId(),
				'sidecar RECREATED (new container id) on kill-137 crash-recreate',
			).not.toBe(idResumed);
			const idAfterKill = sidecarId();

			// (c') Settle — a clean re-boot after the 137 finds the validator present
			// + clean → `chain=present` again. This `fresh`→`present` transition is
			// the SECOND half of the known one-time double: it recreates ONCE more
			// to settle the label on `chain=present` (id changes from idAfterKill).
			const bootSettle = await runBoot({
				stack: engine,
				appName: APP,
				stackName: STACK,
				runtimeRoot,
				routerStateRoot,
				withinScope: () => Effect.void,
			});
			expect(
				bootSettle.failures,
				`boot settle: ${JSON.stringify(bootSettle.failures)}`,
			).toHaveLength(0);
			expect(sidecarConfigHash(), 'config-hash settles to `chain=present`').toContain(
				'indexer-db|chain=present',
			);
			expect(sidecarId(), 'fresh→present settle recreates once more').not.toBe(idAfterKill);

			// (c'') A SECOND clean boot now RESUMES the settled sidecar — steady
			// state restored, proving the post-137 double is exactly ONE re-index,
			// not a per-restart reset.
			const idSettled = sidecarId();
			const bootSteady = await runBoot({
				stack: engine,
				appName: APP,
				stackName: STACK,
				runtimeRoot,
				routerStateRoot,
				withinScope: () => Effect.void,
			});
			expect(
				bootSteady.failures,
				`boot steady: ${JSON.stringify(bootSteady.failures)}`,
			).toHaveLength(0);
			expect(sidecarConfigHash(), 'config-hash unchanged on steady restart').toContain(
				'indexer-db|chain=present',
			);
			expect(sidecarId(), 'sidecar RESUMED (same id) at steady state').toBe(idSettled);

			// (d) Reset-on-regenesis — rm -f the validator so its writable layer
			// (chain state) is gone, forcing a fresh genesis on the next boot.
			const rm = dockerSpawnSync(['rm', '-f', VALIDATOR], { timeout: 30_000 });
			expect(rm.status, `docker rm -f validator: ${rm.stderr}`).toBe(0);

			let chain4 = '';
			const boot4 = await runBoot({
				stack: engine,
				appName: APP,
				stackName: STACK,
				runtimeRoot,
				routerStateRoot,
				withinScope: (ctx) =>
					Effect.sync(() => {
						chain4 = suiChainOf(ctx);
					}),
			});
			// (d) re-boot succeeded with no crash, the validator minted a NEW chain,
			// and the sidecar was RECREATED (new container id) → empty DB → the
			// indexer re-indexes the new chain. The validator was absent pre-sidecar
			// → `chain=fresh` ≠ the live `chain=present` label → recreate.
			expect(boot4.failures, `boot 4: ${JSON.stringify(boot4.failures)}`).toHaveLength(0);
			expect(chain4.length).toBeGreaterThan(0);
			expect(chain4).not.toBe(chainKilled);
			expect(sidecarId(), 'sidecar RECREATED (new container id) on regenesis').not.toBe(idSettled);
		} finally {
			// Clean up every container/network/volume + the temp dirs.
			dockerSpawnSync(['rm', '-f', VALIDATOR, SIDECAR], { timeout: 30_000 });
			dockerSpawnSync(['network', 'rm', `devstack-${APP}-${STACK}-sui-indexer`], {
				timeout: 15_000,
			});
		}
	}, 1_800_000);
});
