// End-to-end boot of `examples/seal-mini-rewrite/` against the real
// docker runtime — focuses on the S7-sugar-fix invariant: the seal
// composite's resolved value carries NO `<unresolved-*>` sentinel
// strings anywhere in its structure.
//
// Stack shape (per `examples/seal-mini-rewrite/devstack.config.ts`):
//   - sui()
//   - account('admin')
//   - seal({mode:'local-keygen', signer: admin,
//           movePackagePath: ...})
//
// Companion test: `seal-boot.test.ts` covers the ready-set assertion
// against the seal docker stub image. This file's job is the
// SENTINEL-ABSENCE invariant — once S7's sugar fix landed, no field
// in the resolved seal handle (objectId, keyServerUrl, serverConfigs[*])
// is permitted to carry a `<unresolved>` placeholder. We walk the
// resolved value recursively and fail on any string that matches
// `/<unresolved/`.
//
// Both this test AND `seal-boot.test.ts` consume the same docker
// stub image fixtures under `test/e2e/fixtures/seal-stub/` — built
// once at suite startup (idempotent thanks to docker layer cache).
//
// Prerequisites: docker reachable on the host.

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
 *  that matches `<unresolved` — the historical sentinel shape the
 *  S7 sugar fix eliminated. Returns the first offending path + value
 *  so the assertion message points at the source. `null` means clean. */
const findUnresolvedSentinel = (
	value: unknown,
	path: string = '$',
	seen: WeakSet<object> = new WeakSet(),
): { readonly path: string; readonly value: string } | null => {
	if (typeof value === 'string') {
		if (value.includes('<unresolved')) return { path, value };
		return null;
	}
	if (value === null || typeof value !== 'object') return null;
	if (seen.has(value as object)) return null;
	seen.add(value as object);
	if (Array.isArray(value)) {
		for (let i = 0; i < value.length; i++) {
			const hit = findUnresolvedSentinel(value[i], `${path}[${i}]`, seen);
			if (hit !== null) return hit;
		}
		return null;
	}
	for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
		// Skip function-valued fields (the resolved value carries
		// closures like `signAndExecute`, `mint`, `server.close`) — they
		// are not user-visible config and would never carry a sentinel.
		if (typeof v === 'function') continue;
		const hit = findUnresolvedSentinel(v, `${path}.${k}`, seen);
		if (hit !== null) return hit;
	}
	return null;
};

describe('seal-mini-rewrite boots end-to-end', () => {
	it('every plugin reaches `ready` and seal resolved value carries no <unresolved> sentinels', async () => {
		const docker = dockerReachable();
		if (!docker.ok) {
			console.warn(`seal-mini-boot: skipping — ${docker.detail}`);
			return;
		}

		const build = buildStubImage();
		expect(build.ok, build.detail).toBe(true);

		// Trust-the-tag fast path in
		// `lifted-siblings/cargo-image.ts::resolveDefaultSealCargoImage`.
		process.env.SEAL_CARGO_IMAGE_OVERRIDE = STUB_IMAGE_TAG;

		const result = await runBoot({
			configPath: CONFIG_PATH,
			appName: 'seal-mini-sentinel',
			stackName: 'main',
		});

		// Three-plugin expectation. Ordinals match the variadic
		// position in `examples/seal-mini-rewrite/devstack.config.ts`:
		// sui(0), admin(1), seal(2). The seal tag id is namespaced
		// `seal:<name>` per `registry-publish.ts::sealTagId`.
		const expectedKeys = ['sui#0', 'account/admin#1', 'seal:seal#2'];
		expect(result.failures).toEqual([]);
		expect(result.topLevelErrorCount).toBe(0);
		expect([...result.readyKeys].sort()).toEqual([...expectedKeys].sort());

		// Walk every resolved value in the projection snapshot
		// (sui#0, admin#1, seal:seal#2) looking for any string that
		// includes `<unresolved`. The S7 sugar fix eliminated these
		// placeholders from the seal composite; a regression would
		// surface here as a non-null match.
		for (const [key, resolved] of result.resolvedValues) {
			const hit = findUnresolvedSentinel(resolved, `$${key}`);
			expect(
				hit,
				hit === null ? '' : `<unresolved> sentinel found at ${hit.path}: ${hit.value}`,
			).toBeNull();
		}

		// Specific seal resolved-value pins. `objectId` must be a
		// real 0x-hex id, `keyServerUrl` must be a real URL, and
		// `serverConfigs` must carry at least one entry whose
		// objectId is also a real 0x-hex id. The local stub Move
		// package exposes the canonical `key_server` register
		// function, so the id comes from the SDK register receipt.
		const seal = result.resolvedValues.get('seal:seal#2') as
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
		expect(seal!.keyServerUrl).toMatch(/^https?:\/\//);
		expect(seal!.serverConfigs.length).toBeGreaterThanOrEqual(1);
		for (const cfg of seal!.serverConfigs) {
			expect(cfg.objectId).toMatch(/^0x[0-9a-f]+$/i);
			expect(cfg.weight).toBeGreaterThan(0);
		}
	}, 200_000);
});
