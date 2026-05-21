// End-to-end boot of `examples/walrus-mini-rewrite/` focused on the
// S8 sugar invariant: the walrus composite's resolved value carries
// NO `<unresolved-*>` / `<seed-account-not-wired>` sentinel strings
// anywhere in its structure. The companion `walrus-stub-boot.test.ts`
// covers the same ready-set against the stub image; this file's job
// is the SENTINEL-ABSENCE invariant — once S8's seedAccounts member-
// tuple sugar landed, no field in the resolved walrus handle
// (packageConfig.*, nodes[*], proxyUrl, aggregator/publisher URLs) is
// permitted to carry a `<unresolved>` / `<seed-account-not-wired>`
// placeholder. We walk the resolved value recursively and fail on any
// string that matches.
//
// Stack shape (per `examples/walrus-mini-rewrite/devstack.config.ts`):
//   - sui()
//   - account('admin')
//   - walrus({ local: { nodeCount: 1, shards: 4, movePackagePath } })
//
// Both this test AND `walrus-stub-boot.test.ts` consume the same
// docker stub image fixtures under `test/e2e/fixtures/walrus-stub/`
// — built once at suite startup (idempotent thanks to docker layer
// cache).
//
// DEFERRED — explicitly out of scope for this test, tracked elsewhere:
//   - Real blob PUT/GET roundtrip via publisher + aggregator. Lives in
//     `walrus-real-boot.test.ts` (needs the real vendored walrus
//     image; ~5min cold-cache build).
//   - Snapshot save → restart → restore roundtrip on a seeded blob.
//     `runBoot` now provides registration-level snapshot wiring; the
//     remaining gap is the full save -> restart -> restore leg per
//     phase-f-e2e-plan Wave 4.
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
	'walrus-mini-rewrite',
	'devstack.config.ts',
);
const STUB_DOCKERFILE_DIR = resolve(HERE, 'fixtures', 'walrus-stub');
const STUB_IMAGE_TAG = 'walrus-test-stub:latest';

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

/** Walk an arbitrary resolved value looking for any string property
 *  that matches a known sentinel shape. Returns the first offending
 *  path + value so the assertion message points at the source. `null`
 *  means clean. Mirrors `seal-mini-boot.test.ts::findUnresolvedSentinel`
 *  — see `test.e2e-recursive-sentinel-walker` opportunity for the
 *  shared-helper consolidation. */
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
		// Skip function-valued fields (the resolved value carries
		// closures like `admin.seedWal`) — they are not user-visible
		// config and would never carry a sentinel.
		if (typeof v === 'function') continue;
		const hit = findSentinel(v, `${path}.${k}`, seen);
		if (hit !== null) return hit;
	}
	return null;
};

describe('walrus-mini-rewrite boots end-to-end', () => {
	it('every plugin reaches `ready` and walrus resolved value carries no <unresolved>/<seed-account-not-wired> sentinels', async () => {
		const docker = dockerReachable();
		if (!docker.ok) {
			console.warn(`walrus-mini-boot: skipping — ${docker.detail}`);
			return;
		}

		const build = buildStubImage();
		expect(build.ok, build.detail).toBe(true);

		// Trust-the-tag fast path in
		// `lifted-siblings/cargo-image.ts::resolveCargoImage`.
		process.env.WALRUS_CARGO_IMAGE_OVERRIDE = STUB_IMAGE_TAG;

		const result = await runBoot({
			configPath: CONFIG_PATH,
			appName: 'walrus-mini-sentinel',
			stackName: 'main',
		});

		// Three-plugin expectation. Ordinals match the variadic
		// position in `examples/walrus-mini-rewrite/devstack.config.ts`:
		// sui(0), admin(1), walrus(2). The walrus tag id is bare
		// `walrus` (singular) — distinct from seal's namespaced
		// `seal:<name>` shape.
		const expectedKeys = ['sui#0', 'account/admin#1', 'walrus#2'];
		expect(result.failures).toEqual([]);
		expect(result.topLevelErrorCount).toBe(0);
		expect([...result.readyKeys].sort()).toEqual([...expectedKeys].sort());

		// Walk every resolved value in the projection snapshot
		// (sui#0, admin#1, walrus#2) looking for any sentinel string.
		// The S8 sugar fix (seedAccounts member-tuple) eliminated
		// these placeholders from the walrus composite's resolved
		// value; a regression would surface here as a non-null match.
		for (const [key, resolved] of result.resolvedValues) {
			const hit = findSentinel(resolved, `$${key}`);
			expect(hit, hit === null ? '' : `sentinel found at ${hit.path}: ${hit.value}`).toBeNull();
		}

		// Specific walrus resolved-value pins. The composite must
		// reach local mode with one storage node, real 0x-hex
		// package config ids (deploy parser output), and non-null
		// proxy/aggregator/publisher URLs from the routable
		// contributions.
		const walrus = result.resolvedValues.get('walrus#2') as
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
		expect(walrus!.nodes.length).toBe(1);
		expect(walrus!.packageConfig.systemObjectId).toMatch(/^0x[0-9a-f]+$/i);
		expect(walrus!.packageConfig.stakingPoolId).toMatch(/^0x[0-9a-f]+$/i);
		expect(walrus!.proxyUrl).toMatch(/^https?:\/\//);
		expect(walrus!.aggregatorUrl).toMatch(/^https?:\/\//);
		expect(walrus!.publisherUrl).toMatch(/^https?:\/\//);
	}, 200_000);
});
