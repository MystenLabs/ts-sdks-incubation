// End-to-end boot of `examples/token-studio/` against the
// real docker runtime. Verifies the publisher-account pattern (alice
// doubles as the `managed_coin` package's publisher) and the wallet
// composition with three accounts.
//
// Stack shape (per `examples/token-studio/devstack.config.ts`):
//   - sui()
//   - account('alice')   — also the package publisher
//   - account('bob')
//   - account('carol')
//   - localPackage('managed_coin', { publisher: alice })
//   - wallet({ accounts: [alice, bob, carol] })
//
// Six plugin keys, with wallet depending on every account + sui.
//
// What this test pins beyond `ready`:
//   - The published `managed_coin` package's output carries the
//     `TreasuryCap<T>` + `CoinMetadata<T>` created objects for every
//     coin declared by the Move module. The package plugin's
//     `coin-discovery.ts` walk uses exactly these object-change rows
//     to populate `treasuryCapId` / `metadataId` in CoinRegistry. By
//     asserting the output's projection here, the discovery walk's
//     load-bearing inputs are pinned non-sentinel.
//
// Prerequisites: docker reachable on the host. Cold runs pay the
// sui container start (60-80s on a fresh runtime root) + the
// managed_coin move build (~10-20s with sui-move local). Subsequent
// runs hit the docker layer cache + the on-disk move build cache.

import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { runBoot } from './boot-config-impl.ts';
import type {
	LocalPackageResolved,
	PackagePublishObjectChange,
} from '../../src/plugins/package/index.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = resolve(
	HERE,
	'..',
	'..',
	'..',
	'..',
	'examples',
	'token-studio',
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

const TREASURY_CAP_RE = /::coin::TreasuryCap<.+>$/;
const COIN_METADATA_RE = /::coin::CoinMetadata<.+>$/;

describe('token-studio boots end-to-end', () => {
	it('every plugin reaches `ready` and managed_coin publish output carries TreasuryCap + CoinMetadata', async () => {
		const docker = dockerReachable();
		if (!docker.ok) {
			console.warn(`token-studio-boot: skipping — ${docker.detail}`);
			return;
		}

		const result = await runBoot({
			configPath: CONFIG_PATH,
			appName: 'token-studio',
			stackName: 'main',
		});

		// Recursive-entrypoint expectation. Ordinals come from the
		// dependency closure rooted at the host app.
		const expectedKeys = [
			'sui#0',
			'account/alice#1',
			'package:managed_coin#2',
			'coin:managed_coin/managed_coin#3',
			'account/bob#4',
			'account/carol#5',
			'wallet#6',
			'host-service/app#7',
		];
		expect(result.failures).toEqual([]);
		expect(result.topLevelErrorCount).toBe(0);
		expect([...result.readyKeys].sort()).toEqual([...expectedKeys].sort());

		// Pull the published package's resolved value. On a fresh boot
		// the output is populated (cache miss); on a warm boot the
		// output is null but the discovery walk has already populated
		// the registry. We assert on the warm-boot-tolerant invariants:
		// either the output exists AND carries the cap + metadata
		// rows, OR (cache hit case) we accept the absence of output.
		// For this test (every invocation gets a fresh tmpdir runtime
		// root, so cache state never carries over) the output is
		// always populated.
		const pkg = result.resolvedValues.get('package:managed_coin#2') as
			| LocalPackageResolved
			| undefined;
		expect(pkg, 'managed_coin resolved value should be present').toBeDefined();
		expect(pkg!.packageId).toMatch(/^0x[0-9a-f]+$/);

		const output = pkg!.publishResult;
		expect(output, 'fresh boot should carry a publish output').not.toBeNull();
		const changes = output!.objectChanges as ReadonlyArray<PackagePublishObjectChange>;

		const treasuryCaps = changes.filter(
			(c) =>
				c.type === 'created' &&
				typeof c.objectType === 'string' &&
				TREASURY_CAP_RE.test(c.objectType),
		);
		const coinMetadatas = changes.filter(
			(c) =>
				c.type === 'created' &&
				typeof c.objectType === 'string' &&
				COIN_METADATA_RE.test(c.objectType),
		);

		expect(
			treasuryCaps.length,
			'managed_coin should publish at least one TreasuryCap<T> object',
		).toBeGreaterThanOrEqual(1);
		expect(
			coinMetadatas.length,
			'managed_coin should publish at least one CoinMetadata<T> object',
		).toBeGreaterThanOrEqual(1);

		// Each cap + metadata row carries a real object id (non-empty
		// 0x-hex), not a sentinel placeholder.
		for (const cap of treasuryCaps) {
			expect(cap.objectId, `TreasuryCap missing objectId`).toBeTruthy();
			expect(cap.objectId!).toMatch(/^0x[0-9a-f]+$/);
			expect(cap.objectId!).not.toMatch(/^<unresolved/);
		}
		for (const meta of coinMetadatas) {
			expect(meta.objectId, `CoinMetadata missing objectId`).toBeTruthy();
			expect(meta.objectId!).toMatch(/^0x[0-9a-f]+$/);
			expect(meta.objectId!).not.toMatch(/^<unresolved/);
		}

		// One TreasuryCap ↔ one CoinMetadata per declared coin — the
		// Move module declares N coins, the publish produces 2N rows.
		expect(treasuryCaps.length, 'each coin should have a paired CoinMetadata').toBe(
			coinMetadatas.length,
		);
	}, 180_000);
});
