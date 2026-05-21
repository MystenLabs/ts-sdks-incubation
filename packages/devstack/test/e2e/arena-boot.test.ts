// End-to-end boot of `examples/arena-rewrite/` against the real
// docker runtime. The most ambitious of the boot tests:
//
//   - Composes an `action('arena.openLobby', ...)` whose body builds,
//     signs, and executes a real `create_lobby` move call against
//     the booted sui container. This pins the Action plugin's full
//     `ctx.signAndExecute(account, build)` sugar round-trip end-to-end
//     (PR3 action: real `ctx.tx → account.signAndExecute → wait`).
//   - Exercises the publisher-account pattern (account('publisher')
//     doubles as the connect_four package's publisher).
//   - Composes a wallet with an explicit `allowedOrigins` allowlist
//     (so origin-policy resolves with non-empty extras).
//
// What this test pins (beyond the per-plugin ready state):
//   - The action's resolved value carries a real, non-stub tx digest
//     (43-char base58 — sui's `TransactionDigest` shape). We assert
//     the digest is present and well-formed, NOT a sentinel like
//     `digest-stubbed-...` or `<stub>` / `<unresolved>`.
//   - `createdObjectCount >= 1` — the `create_lobby` Move entry
//     constructs the `Lobby` singleton via `transfer::share_object(...)`,
//     so the receipt's objectChanges array carries at least one
//     `kind: 'created'` row. A stub digest path would surface a null
//     (no objectChanges field on the resolved value).
//
// Prerequisites: docker reachable on the host. Cold runs pay the sui
// container start + the connect_four move build (the package is
// non-trivial). 180s timeout because the action's executeTransaction
// adds a finality-wait gate on top of the cold-boot path.

import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { runBoot } from './boot-config-impl.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = resolve(
	HERE,
	'..',
	'..',
	'..',
	'..',
	'examples',
	'arena-rewrite',
	'devstack.config.ts',
);

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

describe('arena-rewrite boots end-to-end', () => {
	it('every plugin reaches `ready` and openLobby returns a real digest', async () => {
		const docker = dockerReachable();
		if (!docker.ok) {
			console.warn(`arena-boot: skipping — ${docker.detail}`);
			return;
		}

		const result = await runBoot({
			configPath: CONFIG_PATH,
			appName: 'arena',
			stackName: 'main',
			// Project the action's resolved digest. The key matches
			// the variadic ordinal of `openLobby` in the arena config
			// (see `expectedKeys` below).
			digestFromKey: 'action:arena.openLobby#5',
		});

		// Seven-plugin expectation. Ordinals match the variadic position
		// in the config: sui(0), publisher(1), alice(2), bob(3),
		// connect_four(4), openLobby(5), wallet(6). If the config order
		// changes, update this list AND the `digestFromKey` arg above
		// deliberately.
		const expectedKeys = [
			'sui#0',
			'account/publisher#1',
			'account/alice#2',
			'account/bob#3',
			'package:connect_four#4',
			'action:arena.openLobby#5',
			'wallet#6',
		];
		expect(result.failures).toEqual([]);
		expect(result.topLevelErrorCount).toBe(0);
		expect([...result.readyKeys].sort()).toEqual([...expectedKeys].sort());

		// Real digest, not a stub. Sui digests are base58 (typically
		// 43-44 chars). We don't pin the exact length to leave room
		// for SDK shape changes; we DO pin "non-empty, alphanumeric,
		// not a `digest-...` / `<stub>` / `<unresolved>` placeholder".
		// The PR3-action sugar wires `ctx.signAndExecute(account, build)`
		// onto the real account.signAndExecute → executeTransaction
		// → waitForTransaction round-trip; a stub or skipped path
		// would surface here.
		expect(result.digestFromKey).toBeTruthy();
		expect(result.digestFromKey).not.toMatch(/^digest-/);
		expect(result.digestFromKey).not.toMatch(/^<stub/);
		expect(result.digestFromKey).not.toMatch(/^<unresolved/);
		expect(result.digestFromKey).not.toMatch(/^stub/);
		expect(result.digestFromKey!.length).toBeGreaterThanOrEqual(32);
		expect(result.digestFromKey!).toMatch(/^[1-9A-HJ-NP-Za-km-z]+$/);

		// Real Move call produced at least one created object. The
		// `create_lobby` entry function constructs the `Lobby`
		// singleton via `transfer::share_object(...)`, so the SDK's
		// `effects.changedObjects` carries an `idOperation: 'Created'`
		// row. With `include: { effects, objectTypes }` set by the
		// action plugin's `signAndExecute` helper, the receipt's
		// `objectChanges` array surfaces that row with
		// `kind: 'created'`. A stub digest path would surface a null
		// (no objectChanges field on the resolved value) — pinning
		// `>= 1` rejects both the stub literal AND a real submit
		// that returned without effects.
		expect(result.createdObjectCount).not.toBeNull();
		expect(result.createdObjectCount!).toBeGreaterThanOrEqual(1);
	}, 180_000);
});
