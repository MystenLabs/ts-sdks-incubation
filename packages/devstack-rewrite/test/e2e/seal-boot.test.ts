// End-to-end boot of `examples/seal-mini-rewrite/` with the seal
// upstream image replaced by a docker-built stub (no cargo build).
//
// FIXTURES SHIPPED (all under `test/e2e/fixtures/seal-stub/`):
//
//   - `Dockerfile`            — alpine-based stand-in for the cargo-
//                                 built seal image. Built once with
//                                 `docker build -t seal-test-stub:latest`.
//                                 Exposes two behaviors the plugin's
//                                 local-keygen path drives:
//                                   (a) `seal-cli genkey` one-shot —
//                                       emits `Master key: 0x<hex>` +
//                                       `Public key: 0x<hex>` (32-byte
//                                       + 48-byte hex, matching the
//                                       BLS12-381 widths).
//                                   (b) Default ENTRYPOINT — busybox
//                                       `nc -l -p 2024` loop so the
//                                       key-server `nc -z 127.0.0.1
//                                       2024` ready probe succeeds.
//   - `seal-cli`              — the binary stub shell script the
//                                 Dockerfile COPYs into
//                                 /usr/local/bin/seal-cli.
//   - `Move.toml` + `sources/seal_stub.move`
//                              — minimal Move package consumed by
//                                 `seal({ movePackagePath })`; it
//                                 includes the canonical `key_server`
//                                 register function used by the SDK
//                                 publish/register path.
//
// EXAMPLE APP SHIPPED:
//
//   `examples/seal-mini-rewrite/devstack.config.ts` composes
//   sui + account('admin') + seal({mode:'local-keygen', movePackagePath,
//   signer}) — the smallest stack that exercises the seal composite
//   primitive end-to-end.
//
// SUBSTRATE WIRING: the five walrus-mirror blockers (B1-B5 — stub
// publisher, stub probe, hardcoded sui network/RPC, literal
// `<runtime>/...` mount path, sui cross-container DNS via
// `host.docker.internal`) are fixed in `plugins/seal/index.ts`. This
// test exercises the wired-up acquire body.

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
	'seal-mini-rewrite',
	'devstack.config.ts',
);
const STUB_DOCKERFILE_DIR = resolve(HERE, 'fixtures', 'seal-stub');
const STUB_IMAGE_TAG = 'seal-test-stub:latest';

/** Build the seal stub image. Invoked once at suite startup so the
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

describe('seal-mini-rewrite boots end-to-end', () => {
	it('every plugin reaches `ready` (stub upstream image)', async () => {
		const build = buildStubImage();
		expect(build.ok, build.detail).toBe(true);

		// Trust-the-tag fast path in
		// `lifted-siblings/cargo-image.ts::resolveDefaultSealCargoImage`.
		process.env.SEAL_CARGO_IMAGE_OVERRIDE = STUB_IMAGE_TAG;

		const result = await runBoot({
			configPath: CONFIG_PATH,
			appName: 'seal-mini',
			stackName: 'main',
		});

		// Three-plugin expectation. Ordinals match the variadic
		// position in `examples/seal-mini-rewrite/devstack.config.ts`:
		// sui(0), admin(1), seal(2). The seal tag id is namespaced
		// `seal:<name>` (see registry-publish.ts::sealTagId) — distinct
		// from walrus's bare `walrus` tag id.
		const expectedKeys = ['sui#0', 'account/admin#1', 'seal:seal#2'];
		expect(result.failures).toEqual([]);
		expect(result.topLevelErrorCount).toBe(0);
		expect([...result.readyKeys].sort()).toEqual([...expectedKeys].sort());
	}, 200_000);
});
