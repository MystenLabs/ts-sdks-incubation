// End-to-end boot of `examples/connect-four/` against the real
// docker runtime. The most ambitious of the boot tests:
//
//   - Composes an `action('connect-four.openLobby', ...)` whose body builds,
//     signs, and executes a real `create_lobby` move call against
//     the booted sui container. This pins the Action plugin's full
//     `ctx.signAndExecute(account, build)` sugar round-trip end-to-end
//     (PR3 action: real `ctx.tx → account.signAndExecute → wait`).
//   - Exercises the publisher-account pattern (account('publisher')
//     doubles as the connect_four package's publisher).
//   - Composes a wallet that derives the stack-scoped router origin
//     without caller-supplied origin flags.
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
	'connect-four',
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

describe('connect-four boots end-to-end', () => {
	it('every plugin reaches `ready` and openLobby returns a real digest', async () => {
		const docker = dockerReachable();
		if (!docker.ok) {
			console.warn(`connect-four-boot: skipping — ${docker.detail}`);
			return;
		}

		const result = await runBoot({
			configPath: CONFIG_PATH,
			appName: 'connect-four',
			stackName: 'connect-four',
			// Project the action's resolved digest. The key matches
			// the dependency-closure ordinal of `openLobby` in the connect-four config
			// (see `expectedKeys` below).
			digestFromKey: 'action:connect-four.openLobby#4',
		});

		// Recursive-entrypoint expectation. Ordinals come from the
		// dependency closure rooted at the host app. If this changes,
		// update this list AND the `digestFromKey` arg above deliberately.
		const expectedKeys = [
			'sui#0',
			'account/alice#1',
			'account/publisher#2',
			'package:connect_four#3',
			'action:connect-four.openLobby#4',
			'account/bob#5',
			'wallet#6',
			'host-service/app#7',
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
