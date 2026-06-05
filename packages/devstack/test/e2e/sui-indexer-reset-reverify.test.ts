// E2E regression guard: the Sui-owned indexer DB resets whenever the
// validator re-genesises, and resumes on clean restarts.
//
// The sidecar's configHash folds the validator image ref. Validator data-layer
// resets that are not config values (absent validator or last exit 137) delete
// the sidecar before boot, so the embedded indexer starts from an empty DB.
// The image-ref fold is covered in the unit suite because swapping the
// vendored sui-tools image in e2e is prohibitively heavy.
//
// Local-only: test/e2e is opt-in via DEVSTACK_RUN_E2E and is NOT run in CI; run
// it with `pnpm test:e2e`. Boots the full substrate against real docker:
//   (a) cold boot: default sui() boots; the indexer-db sidecar carries a
//       validator-image-keyed `devstack.config-hash` label.
//   (b) clean restart: a re-boot resumes the sidecar (same id and hash).
//   (c) crash recreate: `docker kill` the validator (SIGKILL -> exit 137), then
//       re-boot; the runtime recreates the validator, and Sui removes the
//       sidecar before boot.
//   (d) deleted validator: `docker rm -f` the validator, then re-boot; the new
//       chain gets a newly-created sidecar DB.

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

describe('sui indexer-db native reset/restore @e2e', () => {
	it('cold-to-restart resumes; kill-137 + rm -f both re-genesise + recreate the sidecar @e2e', async () => {
		if (!dockerOk()) {
			console.warn('sui-native-cfghash: skipping — docker unreachable');
			return;
		}
		const runtimeRoot = mkdtempSync(join(tmpdir(), 'sui-native-cfghash-rt-'));
		const routerStateRoot = mkdtempSync(join(tmpdir(), 'sui-native-cfghash-router-'));
		const engine = readStackEngine(defineDevstack({ members: [sui()], stackName: STACK }));

		try {
			// (a) Cold boot: validator + indexer-db sidecar up; GraphQL answers
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
			expect(cfg1, 'sidecar config-hash label after cold boot').not.toBeNull();
			expect(cfg1, 'config-hash folds the validator image ref').toContain(
				'indexer-db|validator-img=',
			);
			expect(id1, 'sidecar id after cold boot').not.toBeNull();

			// (b) Clean restart: validator state is preserved, so the sidecar
			// resumes immediately.
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
			expect(cfg2, 'config-hash unchanged on clean restart').toBe(cfg1);
			expect(id2, 'sidecar RESUMED (same container id) on clean restart').toBe(id1);
			const idResumed = id2;

			// (c) Reset-on-crash-recreate: record a real SIGKILL/137 on the
			// PERSISTED validator (what an OOM / `docker kill` on a live stack
			// leaves behind). `runBoot` returns with the validator scope-stopped
			// (graceful exit), so START it, then KILL it: the container stays
			// PRESENT but its last exit is 137, so the runtime's `decideRunAction`
			// recreates the `on-failure` container: fresh writable layer, new
			// chain. Sui deletes the sidecar before boot so stale rows cannot
			// survive into the new chain.
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
			expect(chainKilled, 'kill-137 minted a NEW chain (re-genesis)').not.toBe(chain1);
			expect(sidecarConfigHash(), 'config-hash keeps the stable image token').toBe(cfg1);
			expect(
				sidecarId(),
				'sidecar RECREATED (new container id) on kill-137 crash-recreate',
			).not.toBe(idResumed);
			const idAfterKill = sidecarId();

			// (c') The next clean restart resumes the recreated sidecar; the
			// reset happened immediately on the crash-recreate boot.
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
			expect(sidecarConfigHash(), 'config-hash unchanged on steady restart').toBe(cfg1);
			expect(sidecarId(), 'sidecar RESUMED (same id) at steady state').toBe(idAfterKill);

			// (d) Reset-on-regenesis: rm -f the validator so its writable layer
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
			expect(boot4.failures, `boot 4: ${JSON.stringify(boot4.failures)}`).toHaveLength(0);
			expect(chain4.length).toBeGreaterThan(0);
			expect(chain4).not.toBe(chainKilled);
			expect(sidecarId(), 'sidecar RECREATED (new container id) on regenesis').not.toBe(
				idAfterKill,
			);
		} finally {
			// Clean up every container/network/volume + the temp dirs.
			dockerSpawnSync(['rm', '-f', VALIDATOR, SIDECAR], { timeout: 30_000 });
			dockerSpawnSync(['network', 'rm', `devstack-${APP}-${STACK}-sui-indexer`], {
				timeout: 15_000,
			});
		}
	}, 1_800_000);
});
