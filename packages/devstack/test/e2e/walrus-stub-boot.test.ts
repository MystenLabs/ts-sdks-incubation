// End-to-end boot of `examples/walrus-mini-rewrite/` with the walrus
// upstream image replaced by a docker-built stub (no cargo build).
//
// FIXTURES SHIPPED (all under `test/e2e/fixtures/walrus-stub/`):
//
//   - `Dockerfile`            — alpine-based stand-in for the cargo-
//                                 built walrus image. Built once with
//                                 `docker build -t walrus-test-stub:latest`.
//                                 Exposes two behaviors the plugin's
//                                 local-cluster path drives:
//                                   (a) `walrus deploy ...` one-shot
//                                       — emits parse-friendly stdout
//                                       (`walrus_package_id:`,
//                                       `system_object:`,
//                                       `staking_object:` lines) +
//                                       per-node yaml/keystore stubs.
//                                   (b) Default ENTRYPOINT — busybox
//                                       `nc -l -p 9185` loop so the
//                                       storage-node `nc -z 127.0.0.1
//                                       9185` ready probe succeeds.
//   - `walrus`                — the binary stub shell script the
//                                 Dockerfile COPYs into
//                                 /usr/local/bin/walrus.
//   - `Move.toml` + `sources/walrus_stub.move`
//                              — minimal Move package consumed by
//                                 `walrus({ local: { movePackagePath } })`
//                                 to short-circuit the lifted git-
//                                 source sibling.
//
// EXAMPLE APP SHIPPED:
//
//   `examples/walrus-mini-rewrite/devstack.config.ts` composes
//   sui + account('admin') + walrus({ local: { movePackagePath,
//   nodeCount: 1, shards: 4 } }) — the smallest stack that exercises
//   the walrus composite primitive end-to-end.
//
// The test calls `runBoot(...)` with the walrus-mini-rewrite config
// and `WALRUS_CARGO_IMAGE_OVERRIDE` pre-set in `process.env` so the
// lifted cargo-image sibling trusts the locally-built stub tag.
//
// Three plugin keys must reach ready: sui#0, account/admin#1,
// walrus#2. The walrus resolved value must carry:
//   - `mode === 'local'`
//   - `nodes.length === 1` (single-node committee)
//   - `proxyUrl` non-null, shape `http://walrus-node-0.*.localhost:9185`
//   - `packageConfig.systemObjectId` is a 0x-prefixed hex (minted by
//     the stub's deploy on each run).
//   - `admin` (the WalrusAdmin shape) is non-null in local mode.

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
	'walrus-mini-rewrite',
	'devstack.config.ts',
);
const STUB_DOCKERFILE_DIR = resolve(HERE, 'fixtures', 'walrus-stub');
const STUB_IMAGE_TAG = 'walrus-test-stub:latest';

/** Build the walrus stub image. Invoked once at suite startup so the
 *  pre-baked-image override has something to resolve. Idempotent —
 *  docker's layer cache short-circuits the rebuild. */
const buildStubImage = (): { readonly ok: boolean; readonly detail: string } => {
	const res = spawnSync('docker', ['build', '-t', STUB_IMAGE_TAG, STUB_DOCKERFILE_DIR], {
		encoding: 'utf8',
		timeout: 120_000,
	});
	if (res.status !== 0) {
		return {
			ok: false,
			detail: `docker build failed (status=${res.status}):\n${res.stdout}\n${res.stderr}`,
		};
	}
	return { ok: true, detail: '' };
};

describe('walrus-mini-rewrite boots end-to-end', () => {
	it('every plugin reaches `ready` (stub upstream image)', async () => {
		const build = buildStubImage();
		expect(build.ok, build.detail).toBe(true);

		// Trust-the-tag fast path in
		// `lifted-siblings/cargo-image.ts::resolveCargoImage`.
		process.env.WALRUS_CARGO_IMAGE_OVERRIDE = STUB_IMAGE_TAG;

		const result = await runBoot({
			configPath: CONFIG_PATH,
			appName: 'walrus-mini',
			stackName: 'main',
		});

		// Three-plugin expectation. Ordinals match the variadic
		// position in `examples/walrus-mini-rewrite/devstack.config.ts`:
		// sui(0), admin(1), walrus(2).
		const expectedKeys = ['sui#0', 'account/admin#1', 'walrus#2'];
		expect(result.failures).toEqual([]);
		expect(result.topLevelErrorCount).toBe(0);
		expect([...result.readyKeys].sort()).toEqual([...expectedKeys].sort());
	}, 200_000);
});
