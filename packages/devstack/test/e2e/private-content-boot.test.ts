// End-to-end boot of `examples/private-content-rewrite/` — the
// composite-real-walrus + composite-real-seal vault stack. Scoped to
// boot + resolved-value invariants; full vault encrypt/decrypt
// roundtrip is deferred (see below).
//
// Stack shape (per `examples/private-content-rewrite/devstack.config.ts`):
//   - publisher = account('publisher')
//   - alice     = account('alice')
//   - bob       = account('bob')
//   - vault     = localPackage('vault', { publisher })
//   - walrus({ local: { nodeCount: 4, seedAccounts: [publisher, alice, bob] }})
//   - seal({ mode: 'local-keygen', signer: publisher })
//   - wallet({ accounts: 'all' })
//
// The example config does NOT reference stub images / stub move
// packages — its happy path targets the real vendored walrus + seal
// binaries against the real upstream Move sources. This test takes
// the same TEST-OVERRIDE shape as `walrus-mini-boot.test.ts` and
// `seal-mini-boot.test.ts`: point the cargo-image resolvers at the
// pre-built stub images and the move-source resolvers at the on-disk
// stub Move packages. Walrus reuses the mini example source; Seal uses
// the test-owned fixture because register now publishes that source and
// calls the canonical SDK key-server target.
//
// What this test pins:
//
//   1. Every plugin member reaches `ready` — sui + 3 accounts +
//      vault package + walrus composite + seal composite + wallet.
//      Eight keys total: 7 user-declared args plus auto-mounted Sui.
//   2. NO resolved value carries a `<unresolved>` or
//      `<seed-account-not-wired>` sentinel string — the recursive
//      walker mirrors `walrus-mini-boot::findSentinel` /
//      `seal-mini-boot::findUnresolvedSentinel` (the helper-
//      consolidation opportunity is tracked at
//      `test.e2e-recursive-sentinel-walker`).
//   3. The walrus + seal resolved values are well-formed: walrus
//      packageConfig.systemObjectId / stakingPoolId are real 0x-hex
//      ids, proxy/aggregator/publisher URLs are http(s); seal
//      objectId is a real 0x-hex id, keyServerUrl matches the routed
//      `seal-key-server` endpoint.
//
// DEFERRED — explicitly out of scope for this test, tracked
// elsewhere:
//
//   - Full vault roundtrip: encrypt small payload via seal IBE,
//     store/read ciphertext via the Walrus SDK, then decrypt via the
//     seal key-server `/v1/fetch_key`. The SDK publish/register legs
//     are wired; the remaining work is a dedicated programmatic
//     driver that imports generated bindings and performs the signed
//     upload/grant/decrypt transaction flow.
//   - Snapshot save → kill → restore roundtrip across the full
//     composite. `runBoot` now provides registration-level snapshot
//     wiring; the remaining gap is the full save/restore roundtrip.
//
// Prerequisites: docker reachable on the host. Soft-skips otherwise.

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
	'private-content-rewrite',
	'devstack.config.ts',
);

const WALRUS_STUB_DOCKERFILE_DIR = resolve(HERE, 'fixtures', 'walrus-stub');
const SEAL_STUB_DOCKERFILE_DIR = resolve(HERE, 'fixtures', 'seal-stub');
const WALRUS_STUB_IMAGE_TAG = 'walrus-test-stub:latest';
const SEAL_STUB_IMAGE_TAG = 'seal-test-stub:latest';

// Re-use the walrus-mini example's stub Move package. Seal uses the
// test-owned fixture so this e2e can evolve its register-compatible
// source independently from the seal-mini example.
const WALRUS_STUB_MOVE_DIR = resolve(
	HERE,
	'..',
	'..',
	'..',
	'..',
	'examples',
	'walrus-mini-rewrite',
	'move',
	'walrus_stub',
);
const SEAL_STUB_MOVE_DIR = resolve(HERE, 'fixtures', 'seal-stub');

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

const buildStubImage = (
	tag: string,
	dockerfileDir: string,
): { readonly ok: boolean; readonly detail: string } => {
	const res = spawnSync('docker', ['build', '-t', tag, dockerfileDir], {
		encoding: 'utf8',
		timeout: 120_000,
	});
	if (res.status !== 0) {
		return {
			ok: false,
			detail: `docker build ${tag} failed (status=${res.status}):\n${res.stdout}\n${res.stderr}`,
		};
	}
	return { ok: true, detail: '' };
};

/** Recursive sentinel walker — shared shape with
 *  `walrus-mini-boot::findSentinel` and `seal-mini-boot::findUnresolvedSentinel`
 *  (helper-consolidation opportunity tracked at
 *  `test.e2e-recursive-sentinel-walker`). Returns the first matching
 *  path + value so the assertion message points at the offending
 *  field; `null` means clean. */
const SENTINEL_PATTERNS: ReadonlyArray<RegExp> = [/<unresolved/, /<seed-account-not-wired/];
const findSentinel = (
	value: unknown,
	path: string = '$',
	seen: WeakSet<object> = new WeakSet(),
): { readonly path: string; readonly value: string } | null => {
	if (typeof value === 'string') {
		if (SENTINEL_PATTERNS.some((p) => p.test(value))) return { path, value };
		return null;
	}
	if (value === null || typeof value !== 'object') return null;
	if (seen.has(value as object)) return null;
	seen.add(value as object);
	if (Array.isArray(value)) {
		for (let i = 0; i < value.length; i++) {
			const hit = findSentinel(value[i], `${path}[${i}]`, seen);
			if (hit !== null) return hit;
		}
		return null;
	}
	for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
		// Skip function-valued fields (resolved values carry closures
		// like signer.signAndExecute, walrus.publisher.put) — they are
		// not user-visible config and would never carry a sentinel.
		if (typeof v === 'function') continue;
		const hit = findSentinel(v, `${path}.${k}`, seen);
		if (hit !== null) return hit;
	}
	return null;
};

describe('private-content-rewrite boots end-to-end @e2e', () => {
	it('every plugin reaches `ready` and the composite vault stack carries no sentinels', async () => {
		const docker = dockerReachable();
		if (!docker.ok) {
			console.warn(`private-content-boot: skipping — ${docker.detail}`);
			return;
		}

		const walrusBuild = buildStubImage(WALRUS_STUB_IMAGE_TAG, WALRUS_STUB_DOCKERFILE_DIR);
		expect(walrusBuild.ok, walrusBuild.detail).toBe(true);
		const sealBuild = buildStubImage(SEAL_STUB_IMAGE_TAG, SEAL_STUB_DOCKERFILE_DIR);
		expect(sealBuild.ok, sealBuild.detail).toBe(true);

		// Trust-the-tag fast paths in the cargo-image resolvers
		// (`walrus/lifted-siblings/cargo-image.ts` +
		//  `seal/lifted-siblings/cargo-image.ts`).
		process.env.WALRUS_CARGO_IMAGE_OVERRIDE = WALRUS_STUB_IMAGE_TAG;
		process.env.SEAL_CARGO_IMAGE_OVERRIDE = SEAL_STUB_IMAGE_TAG;
		// Trust-the-path fast paths in the move-source resolvers
		// (`walrus/lifted-siblings/source-fetch.ts` +
		//  `seal/lifted-siblings/source-fetch.ts`). The override
		//  path is treated as the Move package root (Move.toml +
		//  sources/) directly — both stub dirs satisfy that shape.
		process.env.WALRUS_MOVE_SOURCE_OVERRIDE = WALRUS_STUB_MOVE_DIR;
		process.env.SEAL_MOVE_SOURCE_OVERRIDE = SEAL_STUB_MOVE_DIR;

		const result = await runBoot({
			configPath: CONFIG_PATH,
			appName: 'private-content-rewrite',
			stackName: 'main',
		});

		// Eight-ready-key expectation. User-declared ordinals match
		// the variadic position in `examples/private-content-rewrite/devstack.config.ts`:
		//   publisher(0), alice(1), bob(2), vault(3), walrus(4),
		//   seal(5), wallet(6). Sui is auto-mounted at the front by
		//   the substrate when absent (S1 sugar) → sui#0 shifts
		//   the user-declared ordinals up by 1. The vault package
		//   tag id is `package:vault`; seal's namespaced tag id is
		//   `seal:seal` per `registry-publish.ts::sealTagId`.
		const expectedKeys = [
			'sui#0',
			'account/publisher#1',
			'account/alice#2',
			'account/bob#3',
			'package:vault#4',
			'walrus#5',
			'seal:seal#6',
			'wallet#7',
		];
		expect(result.failures).toEqual([]);
		expect(result.topLevelErrorCount).toBe(0);
		expect([...result.readyKeys].sort()).toEqual([...expectedKeys].sort());

		// Walk every resolved value in the projection snapshot
		// looking for any sentinel. A regression in S7 (seal sugar)
		// or S8 (walrus seedAccounts sugar) would surface here as
		// a non-null match.
		for (const [key, resolved] of result.resolvedValues) {
			const hit = findSentinel(resolved, `$${key}`);
			expect(hit, hit === null ? '' : `sentinel found at ${hit.path}: ${hit.value}`).toBeNull();
		}

		// Walrus composite resolved-value spot-check. Mirrors
		// `walrus-mini-boot.test.ts` — same shape, same plugin.
		const walrus = result.resolvedValues.get('walrus#5') as
			| {
					readonly mode: 'local' | 'known';
					readonly packageConfig: {
						readonly systemObjectId: string;
						readonly stakingPoolId: string;
					};
					readonly nodes: ReadonlyArray<unknown>;
					readonly proxyUrl: string | null;
					readonly aggregatorUrl: string | null;
					readonly publisherUrl: string | null;
			  }
			| undefined;
		expect(walrus, 'walrus resolved value should be present').toBeDefined();
		expect(walrus!.mode).toBe('local');
		expect(walrus!.nodes.length).toBe(4);
		expect(walrus!.packageConfig.systemObjectId).toMatch(/^0x[0-9a-f]+$/i);
		expect(walrus!.packageConfig.stakingPoolId).toMatch(/^0x[0-9a-f]+$/i);
		expect(walrus!.proxyUrl).toMatch(/^https?:\/\//);
		expect(walrus!.aggregatorUrl).toMatch(/^https?:\/\//);
		expect(walrus!.publisherUrl).toMatch(/^https?:\/\//);

		// Seal composite resolved-value spot-check. Mirrors
		// `seal-mini-boot.test.ts` — same shape, same plugin.
		const seal = result.resolvedValues.get('seal:seal#6') as
			| {
					readonly objectId: string;
					readonly keyServerUrl: string;
					readonly serverConfigs: ReadonlyArray<{
						readonly objectId: string;
						readonly weight: number;
					}>;
			  }
			| undefined;
		expect(seal, 'seal resolved value should be present').toBeDefined();
		expect(seal!.objectId).toMatch(/^0x[0-9a-f]+$/i);
		expect(seal!.keyServerUrl).toBe('http://key-server.private-content-rewrite.localhost:2024');
		expect(seal!.serverConfigs.length).toBeGreaterThanOrEqual(1);
		for (const cfg of seal!.serverConfigs) {
			expect(cfg.objectId).toMatch(/^0x[0-9a-f]+$/i);
			expect(cfg.weight).toBeGreaterThan(0);
		}
	}, 300_000);
});
