// End-to-end boot of `examples/private-content/` — the
// local Walrus + local Seal vault stack. Scoped to
// boot + resolved-value invariants; full vault encrypt/decrypt
// roundtrip lives in the example's Playwright spec.
//
// Stack shape (per `examples/private-content/devstack.config.ts`):
//   - publisher = account('publisher')
//   - alice     = account('alice')
//   - bob       = account('bob')
//   - vault     = localPackage('vault', { publisher })
//   - walrus({ local: { nodeCount: 4, seedAccounts: [publisher, alice, bob] }})
//   - seal({ mode: 'local-keygen', signer: publisher })
//   - wallet({ accounts: 'all', allowedOrigins: [PRIVATE_CONTENT_APP_ORIGIN] })
//
// The example config does NOT reference stub images / stub move
// packages — its happy path targets the real vendored walrus + seal
// binaries against the real upstream Move sources. This test uses
// test-owned override fixtures: pre-built stub images for both services
// and an on-disk stub Move package for Seal.
//
// What this test pins:
//
//   1. Every plugin member reaches `ready` — explicit sui + 3 accounts +
//      vault package + walrus service + seal service + wallet.
//      Eight keys total.
//   2. NO resolved value carries a `<unresolved>` or
//      `<seed-account-not-wired>` sentinel string — the recursive
//      walker reports the first offending path so the assertion
//      points at the unresolved field.
//   3. The walrus + seal resolved values are well-formed: walrus
//      packageConfig.systemObjectId / stakingPoolId are real 0x-hex
//      ids, proxy/aggregator/publisher URLs are http(s); seal
//      objectId is a real 0x-hex id, keyServerUrl matches the routed
//      `seal-key-server` endpoint.
//   4. The wallet accepts the example's Vite origin, proving the
//      browser app can pair from the same URL Playwright opens.
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
//     local services. `runBoot` now provides registration-level snapshot
//     wiring; the remaining gap is the full save/restore roundtrip.
//
// Prerequisites: docker reachable on the host. Soft-skips otherwise.

import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Effect } from 'effect';
import { describe, expect, it } from 'vitest';

import {
	WALLET_AUTH_HEADER,
	WALLET_BEARER_PREFIX,
	WalletHttpPath,
} from '../../src/plugins/wallet/protocol.ts';
import type { WalletValue } from '../../src/plugins/wallet/service.ts';
import { runBoot } from './boot-config-impl.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = resolve(
	HERE,
	'..',
	'..',
	'..',
	'..',
	'examples',
	'private-content',
	'devstack.config.ts',
);

const WALRUS_STUB_DOCKERFILE_DIR = resolve(HERE, 'fixtures', 'walrus-stub');
const SEAL_STUB_DOCKERFILE_DIR = resolve(HERE, 'fixtures', 'seal-stub');
const WALRUS_STUB_IMAGE_TAG = 'walrus-test-stub:latest';
const SEAL_STUB_IMAGE_TAG = 'seal-test-stub:latest';
const PRIVATE_CONTENT_ROUTER_ORIGIN = 'http://dev.private-content.private-content.localhost:5175';

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
 *  Returns the first matching path + value so the assertion message
 *  points at the offending field; `null` means clean. */
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

describe('private-content boots end-to-end @e2e', () => {
	it('every plugin reaches `ready` and the vault stack carries no sentinels', async () => {
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
		// (`walrus/bootstrap-assets/cargo-image.ts` +
		//  `seal/bootstrap-assets/cargo-image.ts`).
		process.env.WALRUS_CARGO_IMAGE_OVERRIDE = WALRUS_STUB_IMAGE_TAG;
		process.env.SEAL_CARGO_IMAGE_OVERRIDE = SEAL_STUB_IMAGE_TAG;
		// Trust-the-path fast path in Seal's move-source resolver. The
		// override path is treated as the Move package root (Move.toml
		// + sources/) directly.
		process.env.SEAL_MOVE_SOURCE_OVERRIDE = SEAL_STUB_MOVE_DIR;

		let walletHealthStatus: number | null = null;
		const result = await runBoot({
			configPath: CONFIG_PATH,
			appName: 'private-content',
			stackName: 'private-content',
			withinScope: (ctx) =>
				Effect.gen(function* () {
					const wallet = ctx.resolvedValues.get('wallet#7') as WalletValue | undefined;
					if (wallet === undefined) return;
					walletHealthStatus = yield* Effect.promise(async () => {
						try {
							const res = await fetch(`${wallet.url}${WalletHttpPath.HEALTH}`, {
								headers: {
									[WALLET_AUTH_HEADER]: `${WALLET_BEARER_PREFIX}${wallet.token}`,
									origin: PRIVATE_CONTENT_ROUTER_ORIGIN,
								},
							});
							return res.status;
						} catch {
							return null;
						}
					});
				}),
		});

		// Recursive-entrypoint expectation. Ordinals come from the
		// dependency closure rooted at the host app. The vault package
		// resource id is `package:vault`; seal's namespaced resource id is
		// `seal:seal` per `registry-publish.ts::sealResourceId`.
		const expectedKeys = [
			'sui#0',
			'account/publisher#1',
			'package:vault#2',
			'account/alice#3',
			'account/bob#4',
			'walrus:walrus',
			'seal:seal',
			'wallet#7',
			'host-service/app#8',
		];
		expect(result.failures).toEqual([]);
		expect(result.topLevelErrorCount).toBe(0);
		expect([...result.readyKeys].sort()).toEqual([...expectedKeys].sort());
		expect(walletHealthStatus).toBe(200);

		// Walk every resolved value in the projection snapshot
		// looking for any sentinel. A regression in S7 (seal sugar)
		// or S8 (walrus seedAccounts sugar) would surface here as
		// a non-null match.
		for (const [key, resolved] of result.resolvedValues) {
			const hit = findSentinel(resolved, `$${key}`);
			expect(hit, hit === null ? '' : `sentinel found at ${hit.path}: ${hit.value}`).toBeNull();
		}

		// Walrus resolved-value spot-check.
		const walrus = result.resolvedValues.get('walrus:walrus') as
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

		// Seal resolved-value spot-check.
		const seal = result.resolvedValues.get('seal:seal') as
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
		expect(seal!.keyServerUrl).toBe(
			'http://key-server.private-content.private-content.localhost:2024',
		);
		expect(seal!.serverConfigs.length).toBeGreaterThanOrEqual(1);
		for (const cfg of seal!.serverConfigs) {
			expect(cfg.objectId).toMatch(/^0x[0-9a-f]+$/i);
			expect(cfg.weight).toBeGreaterThan(0);
		}
	}, 300_000);
});
