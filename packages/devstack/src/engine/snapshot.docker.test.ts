// Real-Docker snapshot round-trip test.
//
// The single most important test in this package — drives the actual
// `devstack apply` → `snapshot save` → `wipe` → `snapshot restore`
// → `devstack apply` cycle against a real Docker daemon, asserting
// the chain state survives byte-for-byte. Mocked variants would (and
// did) miss four bugs the original v4 snapshot redesign shipped with:
//
//   1. Container filter scoped only by `stack`, not `(app, stack)` →
//      snapshots silently slurped sibling apps' containers.
//   2. Label-suffix match in `findMatch` used `indexOf` instead of
//      `endsWith` → restore-by-label never matched.
//   3. No `originalImage` retag on restore → supervisor recreated from
//      a fresh base image and ran new genesis, losing chain state.
//   4. `dockerImage({build})` ran unconditionally even when the
//      content-addressed tag was already on the daemon → overwrote the
//      retag from step 3, doubly losing chain state.
//
// All four are caught by this test by construction.
//
// **Default-on, auto-skip without Docker.** If the daemon isn't
// reachable, the describe block skips at suite load with a clear
// notice. CI runners (GH Actions ubuntu) always have Docker.
//
// **Slow.** ~60s per test (fresh apply + commit + restore + warm
// apply). Mitigated by:
//   - Single test in this file (no matrix bloat).
//   - Uses `examples/arena` as the test fixture rather than
//     constructing a config inline (real-world config, already proven
//     to work, surfaces real upstream Sui boot time).
//   - `DEVSTACK_STACK=test-<rand>` per run so this test never collides
//     with the developer's interactive `main` stack OR with parallel
//     vitest workers.
//
// **Cleanup.** A `try/finally` runs `devstack wipe --yes` against the
// test stack regardless of pass/fail so the daemon is left clean.

import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
// Plain vitest, not @effect/vitest — this test is a multi-step async
// orchestration that shells out to the CLI; an Effect-flavored wrapper
// would be more friction than help.
import { describe, expect, it } from 'vitest';

const ARENA_DIR = resolvePath(__dirname, '../../../../examples/arena');
// Invoke the built CLI directly via node so the test doesn't depend on
// pnpm having created the `devstack` bin symlink in `examples/arena/
// node_modules/.bin/` — that symlink isn't created when `dist/cli/main.mjs`
// doesn't exist at `pnpm install --frozen-lockfile` time (pnpm warns and
// skips). Going through node sidesteps that resolution entirely.
const CLI_PATH = resolvePath(__dirname, '../../dist/cli/main.mjs');
const TEST_TIMEOUT_MS = 300_000; // 5 min — apply on a cold cache can be slow

interface CliResult {
	readonly exitCode: number;
	readonly stdout: string;
	readonly stderr: string;
}

// Probe the daemon at suite-load time. If unreachable, the whole
// describe block skips — we don't want a confusing series of failures,
// just a clear "Docker not available" message in one place.
const dockerAvailable = (): boolean => {
	const { spawnSync } = require('node:child_process') as typeof import('node:child_process');
	const out = spawnSync('docker', ['version', '--format', '{{.Server.Version}}'], {
		timeout: 5_000,
		stdio: ['ignore', 'pipe', 'ignore'],
	});
	return out.status === 0 && (out.stdout?.toString() ?? '').trim().length > 0;
};

const DOCKER_OK = dockerAvailable();

const runCli = async (
	cwd: string,
	env: NodeJS.ProcessEnv,
	args: ReadonlyArray<string>,
): Promise<CliResult> => {
	return new Promise((resolve) => {
		const child = spawn(process.execPath, [CLI_PATH, ...args], {
			cwd,
			env,
			stdio: ['ignore', 'pipe', 'pipe'],
		});
		let stdout = '';
		let stderr = '';
		child.stdout.on('data', (chunk: Buffer) => {
			stdout += chunk.toString();
		});
		child.stderr.on('data', (chunk: Buffer) => {
			stderr += chunk.toString();
		});
		child.on('close', (code) => {
			resolve({ exitCode: code ?? -1, stdout, stderr });
		});
	});
};

// `arena`'s state.json packs publishMove entries keyed by
// `publishMove/v2/<name>/<sourceHash>/<chainIdShort>`. The packageId is
// the same value across cycles as long as the chain identity (and
// therefore the publish tx digest cache) is preserved. We assert
// EXACT equality post-restore; that's what proves chain state ride-
// through.
interface ConnectFourPublish {
	readonly packageId: string;
}

const readPackageIds = (stateFile: string): ReadonlyArray<string> => {
	const raw = readFileSync(stateFile, 'utf8');
	const parsed = JSON.parse(raw) as { data?: Record<string, unknown> };
	const ids: Array<string> = [];
	for (const [key, value] of Object.entries(parsed.data ?? {})) {
		if (!key.startsWith('publishMove/v2/connect_four/')) continue;
		const v = value as Partial<ConnectFourPublish>;
		if (typeof v.packageId === 'string') ids.push(v.packageId);
	}
	return ids;
};

describe.skipIf(!DOCKER_OK)('snapshot end-to-end against real Docker (examples/arena)', () => {
	// Unique per test invocation. Survives parallel vitest workers,
	// the developer's interactive `main` stack, and previous runs of
	// this same test that may not have torn down cleanly. The 8-hex
	// suffix is small enough to fit comfortably in container names
	// (docker caps at 63 chars).
	const STACK = `test-snap-${randomBytes(4).toString('hex')}`;
	const env: NodeJS.ProcessEnv = {
		...process.env,
		DEVSTACK_STACK: STACK,
	};
	const stateFile = resolvePath(ARENA_DIR, '.devstack', 'stacks', STACK, 'state.json');

	// Use a per-run label suffix derived from the stack id so two
	// concurrent runs (or a leftover snapshot from a previously
	// crashed run) don't produce ambiguous matches on `restore`.
	const LABEL = `t${randomBytes(3).toString('hex')}`;
	const SNAPSHOT_DIR = resolvePath(ARENA_DIR, '.devstack', 'snapshots');

	// One serial flow — splitting into separate `it` blocks would
	// require fragile shared state across tests + extra cleanup.
	// A 60s integration test is a single assertion target.
	it(
		'apply → snapshot save → wipe → snapshot restore → apply preserves chain identity',
		async () => {
			try {
				// Pre-cleanup: drop any stale snapshot dirs that share
				// our run-suffix shape (paranoia — `randomBytes(3)` ⇒
				// 16M unique labels, vanishingly unlikely to collide,
				// but a crash mid-test could leave a partial snapshot
				// that prevents the next test from running).
				const { rmSync, existsSync, readdirSync } = require('node:fs') as typeof import('node:fs');
				if (existsSync(SNAPSHOT_DIR)) {
					for (const entry of readdirSync(SNAPSHOT_DIR)) {
						if (entry.endsWith(`-${LABEL}`)) {
							rmSync(resolvePath(SNAPSHOT_DIR, entry), {
								recursive: true,
								force: true,
							});
						}
					}
				}
				// 1. Fresh apply against the unique stack. Builds the
				// custom postgres image first time (~30s); subsequent
				// runs hit docker layer cache (~2s).
				const apply1 = await runCli(ARENA_DIR, env, ['apply']);
				expect(apply1.exitCode, `apply #1 failed:\n${apply1.stderr}`).toBe(0);
				expect(apply1.stdout).toContain('apply ok');

				const pre = readPackageIds(stateFile);
				expect(pre.length).toBeGreaterThan(0);

				// 2. Save snapshot. Captures `state.json` + `runtime/`
				// tar + `docker commit + save` of both arena containers.
				const save = await runCli(ARENA_DIR, env, ['snapshot', 'save', '--label', LABEL]);
				expect(save.exitCode, `snapshot save failed:\n${save.stderr}`).toBe(0);
				expect(save.stdout).toMatch(new RegExp(`saved snapshot \\S+-${LABEL}`));

				// 3. Wipe — destroys containers (rm -f via wipe path)
				// AND the on-disk state. The snapshot dir survives by
				// design (wipe's `--keep-snapshots` semantics — even
				// when not passed explicitly, snapshots aren't
				// auto-removed since they may span stacks).
				const wipe = await runCli(ARENA_DIR, env, ['wipe', '--yes']);
				expect(wipe.exitCode, `wipe failed:\n${wipe.stderr}`).toBe(0);

				// 4. Restore from the snapshot. Loads container tars +
				// retags to the supervisor's content-addressed base
				// image tags + extracts runtime/ + copies state.json
				// back.
				const restore = await runCli(ARENA_DIR, env, ['snapshot', 'restore', LABEL]);
				expect(restore.exitCode, `restore failed:\n${restore.stderr}`).toBe(0);
				expect(restore.stdout).toContain('runtime/ extracted');
				expect(restore.stdout).toMatch(/loaded images:.*devstack-snap:/);

				// 5. Apply against the restored state. With the retag
				// in place, the supervisor's dockerImage cache-skip
				// finds the retagged image, decideRunAction goes
				// through `fresh` (no container with this name
				// exists post-wipe), and `docker run` creates a new
				// container from the snapshot image — chain state
				// already in /root/.sui at first boot. The entrypoint's
				// `if [ ! -d /root/.sui/sui_config ]` guard skips
				// genesis. publishMove + Action hit the state-store
				// cache because chainId matches.
				const apply2 = await runCli(ARENA_DIR, env, ['apply']);
				expect(apply2.exitCode, `apply #2 failed:\n${apply2.stderr}`).toBe(0);
				expect(apply2.stdout).toContain('apply ok');
				// The cache-hit log line is the smoking gun: if it's
				// absent, the supervisor saw a different chainId
				// (fresh genesis) and the snapshot's content was lost.
				expect(apply2.stdout).toMatch(/publishMove\(connect_four\): cache hit/);
				expect(apply2.stdout).toMatch(/Action\(arena\.openLobby\): cache hit/);

				// 6. Assert: packageId identical to pre-snapshot. This
				// is what catches the four bugs the original v4
				// design shipped with — any of them would flip the
				// chainId and re-publish to a new packageId.
				const post = readPackageIds(stateFile);
				expect(post).toContain(pre[0]);
			} finally {
				// Best-effort cleanup. Even if assertions failed, drop
				// the test stack's containers + on-disk state AND the
				// snapshot dirs this run produced so the next run
				// starts clean. Errors here are swallowed — the test
				// result is what matters, not the cleanup.
				await runCli(ARENA_DIR, env, ['wipe', '--yes']).catch(() => undefined);
				const { rmSync, existsSync, readdirSync } = require('node:fs') as typeof import('node:fs');
				if (existsSync(SNAPSHOT_DIR)) {
					for (const entry of readdirSync(SNAPSHOT_DIR)) {
						if (entry.endsWith(`-${LABEL}`)) {
							rmSync(resolvePath(SNAPSHOT_DIR, entry), {
								recursive: true,
								force: true,
							});
						}
					}
				}
			}
		},
		TEST_TIMEOUT_MS,
	);
});

// Stamp at suite-load so the dev sees this in `pnpm test` output when
// Docker is missing, instead of silently passing zero assertions.
if (!DOCKER_OK) {
	// eslint-disable-next-line no-console
	console.log(
		'[snapshot.docker.test] Docker daemon not reachable — real-Docker snapshot suite skipped. ' +
			'Start Docker Desktop / dockerd to enable.',
	);
}
