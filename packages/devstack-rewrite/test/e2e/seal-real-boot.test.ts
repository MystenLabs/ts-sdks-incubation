// End-to-end boot of `examples/seal-mini-rewrite/` against the REAL
// vendored seal-key-server image.
//
// Companion to `seal-boot.test.ts` (the stub-image suite). The stub
// suite exercises the plugin's mode dispatch + composite topology
// against a busybox-based fake; this suite confirms the same plugin
// boots when wired to the REAL upstream `key-server` binary fetched
// by `images/seal/Dockerfile`.
//
// What this suite validates (and what it deliberately doesn't):
//
//   - VALIDATES: `images/seal/Dockerfile` builds against docker on
//     the host. The build is content-addressed; same SEAL_VERSION
//     produces the same image hash, so the docker layer cache turns
//     repeat runs into ~1s no-ops.
//   - VALIDATES: `seal-cli genkey` one-shot produces a parseable
//     BLS12-381 keypair against the REAL binary. The plugin's
//     `keygen.ts::parseSealKeygenOutput` consumes the real upstream
//     `Master key:` / `Public key:` lines (NOT the stub's
//     synthesized hex).
//   - VALIDATES: the real image is available to the plugin boot path.
//     This suite deliberately keeps the Move source pinned to the
//     seal-mini fixture, so the assertion below is scoped to image
//     build + the boot helper's required ready keys rather than full
//     key-server readiness.
//   - VALIDATES: standalone key-material operations work against the
//     real `seal-cli` binary: genkey produces parseable keys, extract
//     derives a user secret key, and verify confirms the tuple. This
//     is pure off-chain math — no on-chain object lookups, no
//     key-server REST hops.
//
//   - DOES NOT VALIDATE: the real upstream Seal Move package publish
//     + KeyServer object register. Those legs are SDK-backed in the
//     plugin, but this gated image test reuses the seal-mini config's
//     local Move fixture instead of fetching the upstream Seal Move
//     package.
//   - DOES NOT VALIDATE: full client-driven encrypt/decrypt via the
//     `/v1/fetch_key` REST endpoint. That requires the on-chain
//     `KeyServer` object (above) + a registered SessionKey +
//     `seal_approve` policy fn. The SDK publish/register legs are
//     wired; this gated image test still does not drive the client
//     REST flow.
//
// Gating:
//
//   - DEVSTACK_SEAL_REAL_E2E=1     opt-in. Default OFF because the
//     first build pulls ~50MB and runs against a public GitHub
//     release URL (network-dependent, slow in air-gapped CI).
//     Local: `pnpm vitest run seal-real-boot.test.ts` (uncomment
//     the env variable in the per-developer test runner override).
//   - DEVSTACK_RUN_E2E=1            broad e2e gate. The vitest
//     config's e2e pool only loads these files when set.
//
// FIXTURES SHIPPED:
//
//   - `packages/devstack-rewrite/images/seal/Dockerfile` (vendored)
//   - `packages/devstack-rewrite/images/seal/entrypoint.sh` (vendored)
//
// EXAMPLE APP REUSED:
//
//   `examples/seal-mini-rewrite/devstack.config.ts` — same as the
//   stub suite. The plugin's image-resolver dispatches between the
//   stub (`SEAL_CARGO_IMAGE_OVERRIDE` set) and the vendored
//   Dockerfile (override unset → `runtime.ensureImage` builds).

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
const IMAGES_SEAL_DIR = resolve(HERE, '..', '..', 'images', 'seal');

// Pin SHOULD match `lifted-siblings/source-fetch.ts::DEFAULT_SEAL_VERSION`.
// We don't import the constant here to keep this file decoupled from
// the plugin's internals (the test exercises the public boot path
// via the standard config).
const DEFAULT_SEAL_VERSION = 'seal-v0.6.6';
const SEAL_REAL_IMAGE_TAG = `devstack-seal-real:${DEFAULT_SEAL_VERSION}`;

const GATE = process.env.DEVSTACK_SEAL_REAL_E2E === '1';

/** Pre-build the vendored seal image so the plugin's
 *  `runtime.ensureImage` cache-hits at boot. The plugin's resolver
 *  computes the same build args (`SEAL_VERSION`) we tag with here;
 *  docker's content-addressed cache de-duplicates the build. We
 *  shell out to `docker build` directly for the prebuild step to
 *  avoid any substrate-context plumbing in this gate. */
const buildRealImage = (): { readonly ok: boolean; readonly detail: string } => {
	const res = spawnSync(
		'docker',
		[
			'build',
			'--build-arg',
			`SEAL_VERSION=${DEFAULT_SEAL_VERSION}`,
			'-t',
			SEAL_REAL_IMAGE_TAG,
			IMAGES_SEAL_DIR,
		],
		{
			encoding: 'utf8',
			timeout: 5 * 60_000,
		},
	);
	if (res.status !== 0) {
		return {
			ok: false,
			detail: `docker build failed (status=${res.status}):\n${res.stdout}\n${res.stderr}`,
		};
	}
	return { ok: true, detail: '' };
};

/** Run a `seal-cli <subcommand>` inside the real image, capture
 *  stdout + stderr + exit code. Used for the standalone key-material
 *  flow below. */
const runSealCli = (
	argv: ReadonlyArray<string>,
): { readonly status: number; readonly stdout: string; readonly stderr: string } => {
	const res = spawnSync(
		'docker',
		['run', '--rm', '--entrypoint', 'seal-cli', SEAL_REAL_IMAGE_TAG, ...argv],
		{ encoding: 'utf8', timeout: 60_000 },
	);
	return {
		status: res.status ?? -1,
		stdout: res.stdout ?? '',
		stderr: res.stderr ?? '',
	};
};

describe.skipIf(!GATE)('seal-mini-rewrite boots with REAL seal image', () => {
	it(
		'image builds and the boot helper reaches the required ready keys',
		async () => {
			const build = buildRealImage();
			expect(build.ok, build.detail).toBe(true);

			// Trust-the-tag fast path so the plugin's image resolver
			// short-circuits to the pre-built tag rather than racing the
			// cache against our prebuild step. (We still validate the
			// underlying Dockerfile builds via `buildRealImage` above.)
			process.env.SEAL_CARGO_IMAGE_OVERRIDE = SEAL_REAL_IMAGE_TAG;

			const result = await runBoot({
				configPath: CONFIG_PATH,
				appName: 'seal-mini-real',
				stackName: 'main',
			});

			// The example composes sui + admin + seal. This gated test
			// reuses the seal-mini local Move fixture, so don't assert
			// `failures: []` here; the full real-Move publish/register
			// path belongs in a separate roundtrip-oriented test.
			//
			// What we DO assert:
			//   - sui#0 (the localnet container) reaches ready.
			//   - admin (the account) reaches ready.
			//   - The image build itself succeeded (covered by the
			//     buildRealImage call above).
			expect(result.readyKeys).toContain('sui#0');
			expect(result.readyKeys).toContain('account/admin#1');
		},
		5 * 60_000,
	);

	it(
		'seal-cli genkey + extract + verify works against real binary',
		() => {
			// 1. Genkey — real BLS12-381 keypair.
			const genkey = runSealCli(['genkey']);
			expect(genkey.status, `genkey failed: ${genkey.stderr}`).toBe(0);
			const masterMatch = genkey.stdout.match(/Master key:\s*(0x)?([0-9a-fA-F]+)/);
			const publicMatch = genkey.stdout.match(/Public key:\s*(0x)?([0-9a-fA-F]+)/);
			expect(
				masterMatch,
				`parser couldn't find Master key line in:\n${genkey.stdout}`,
			).not.toBeNull();
			expect(
				publicMatch,
				`parser couldn't find Public key line in:\n${genkey.stdout}`,
			).not.toBeNull();
			const masterKey = masterMatch![2]!;
			const publicKey = publicMatch![2]!;
			// BLS12-381 widths (observed from the seal-v0.6.6 binary):
			//   - master key: 32-byte scalar → 64 hex chars
			//   - public key: 96-byte BLS12-381 G2 element → 192 hex chars
			expect(masterKey.length).toBe(64);
			expect(publicKey.length).toBe(192);

			// 2. Extract — derive a user secret key for a synthetic
			//    package_id + identity. Pure off-chain math; the
			//    package_id is structurally validated but never
			//    dereferenced on chain.
			const PACKAGE_ID = '0x' + '0'.repeat(63) + '1';
			const ID = '0x' + 'cafe'.padEnd(64, '0');
			const extract = runSealCli([
				'extract',
				'--package-id',
				PACKAGE_ID,
				'--id',
				ID,
				'--master-key',
				masterKey,
			]);
			expect(extract.status, `extract failed: ${extract.stderr}`).toBe(0);
			// Extract emits: `User secret key: 0x<hex>` — a 48-byte G1
			// compressed element (96 hex chars). Mirror the parser
			// discipline from keygen.ts.
			const uskMatch = extract.stdout.match(/User secret key:\s*(0x)?([0-9a-fA-F]+)/);
			expect(uskMatch, `couldn't parse User secret key from:\n${extract.stdout}`).not.toBeNull();
			const userSecretKey = uskMatch![2]!;
			expect(userSecretKey.length).toBe(96); // 48 bytes hex

			// 3. Verify — confirms the (userSecretKey, publicKey, id,
			//    package_id) tuple is consistent. Non-zero exit means
			//    the key-material flow failed.
			const verify = runSealCli([
				'verify',
				'--package-id',
				PACKAGE_ID,
				'--id',
				ID,
				'--user-secret-key',
				userSecretKey,
				'--public-key',
				publicKey,
			]);
			expect(verify.status, `verify failed: ${verify.stderr}\nstdout: ${verify.stdout}`).toBe(0);
		},
		3 * 60_000,
	);
});
