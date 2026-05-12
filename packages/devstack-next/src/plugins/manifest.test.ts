import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Engine } from '../engine/class.js';
import type { Env } from '../engine/types.js';
import { dep } from '../factories/dep.js';
import { define } from '../factories/define.js';
import type { Account, Endpoint, Package } from '../shapes/index.js';
import { manifest, renderManifest } from './manifest.js';

let appDir: string;

beforeEach(async () => {
	appDir = await mkdtemp(join(tmpdir(), 'devstack-next-manifest-'));
});

afterEach(async () => {
	await rm(appDir, { recursive: true, force: true });
});

function envFor(stack = 'main'): Env {
	return { appName: 'demo', appDir, network: 'localnet', stack };
}

// Synthetic upstream producers — represent themselves as a Package /
// Endpoint / Account so manifest can fan in via the typed deps.
function makePackageProducer(name: string, packageId: string) {
	type S = { name: string; packageId: string };
	return define<S>({
		name: `pkg.${name}`,
		provides: { package: dep((s: S): Package => ({ name: s.name, packageId: s.packageId })) },
		start: async () => ({ name, packageId }),
	});
}

function makeEndpointProducer(name: string, url: string, kind?: string) {
	type S = { name: string; url: string; kind?: string };
	return define<S>({
		name: `ep.${name}`,
		provides: {
			endpoint: dep((s: S): Endpoint => {
				const result: Endpoint = { name: s.name, url: s.url };
				if (s.kind !== undefined) result.kind = s.kind;
				return result;
			}),
		},
		start: async () => {
			const result: S = { name, url };
			if (kind !== undefined) result.kind = kind;
			return result;
		},
	});
}

function makeAccountProducer(name: string, address: string) {
	type S = { name: string; address: string };
	return define<S>({
		name: `acc.${name}`,
		provides: { account: dep((s: S): Account => ({ name: s.name, address: s.address })) },
		start: async () => ({ name, address }),
	});
}

describe('manifest', () => {
	it('emits a typed manifest TypeScript file from upstream Deps', async () => {
		const token = makePackageProducer('token', '0xpkg1');
		const nft = makePackageProducer('nft', '0xpkg2');
		const rpc = makeEndpointProducer('sui-rpc', 'http://localhost:9000', 'rpc');
		const publisher = makeAccountProducer('publisher', '0xacc1');

		const generate = manifest({
			packages: [token.get('package'), nft.get('package')],
			endpoints: [rpc.get('endpoint')],
			accounts: [publisher.get('account')],
		});

		const engine = new Engine({ stack: [generate] }, { env: envFor() });
		const result = await engine.runOnce();

		expect(result.errored).toEqual([]);
		expect(result.ran.map((r) => r.name)).toContain('manifest');

		const path = join(appDir, 'src/generated/manifest.ts');
		const body = await readFile(path, 'utf8');
		expect(body).toContain('AUTO-GENERATED');
		expect(body).toContain('"name": "nft"');
		expect(body).toContain('"name": "token"');
		expect(body).toContain('"address": "0xacc1"');
		expect(body).toContain('"url": "http://localhost:9000"');
	});

	it('writes packages sorted alphabetically (stable diffs)', () => {
		const body = renderManifest({
			packages: [
				{ name: 'zeta', packageId: '0x9' },
				{ name: 'alpha', packageId: '0x1' },
				{ name: 'mu', packageId: '0x5' },
			],
			endpoints: [],
			accounts: [],
			coins: [],
			extras: {},
		});
		const alphaIdx = body.indexOf('"alpha"');
		const muIdx = body.indexOf('"mu"');
		const zetaIdx = body.indexOf('"zeta"');
		expect(alphaIdx).toBeGreaterThan(0);
		expect(alphaIdx).toBeLessThan(muIdx);
		expect(muIdx).toBeLessThan(zetaIdx);
	});

	it('dedupes by name (last write wins) so duplicate Deps are tolerated', () => {
		const body = renderManifest({
			packages: [
				{ name: 'token', packageId: '0xold' },
				{ name: 'token', packageId: '0xnew' },
			],
			endpoints: [],
			accounts: [],
			coins: [],
			extras: {},
		});
		expect(body).toContain('"packageId": "0xnew"');
		expect(body).not.toContain('"packageId": "0xold"');
	});

	it('does not rewrite the file when forced re-run produces identical content', async () => {
		const token = makePackageProducer('token', '0xpkg1');
		const generate = manifest({ packages: [token.get('package')] });
		const engine = new Engine({ stack: [generate] }, { env: envFor() });

		await engine.runOnce();
		const path = join(appDir, 'src/generated/manifest.ts');
		const mtimeFirst = (await stat(path)).mtimeMs;

		// Tiny sleep so a re-write would produce a different mtime.
		await new Promise((r) => setTimeout(r, 20));

		// Force re-run manifest. forceRun bypasses getStatus, so run() fires.
		// run()'s own content-equality check should suppress the write.
		engine.invalidate('manifest');
		const result = await engine.cycle();
		expect(result.ran.map((r) => r.name)).toContain('manifest');
		const mtimeSecond = (await stat(path)).mtimeMs;
		expect(mtimeSecond).toBe(mtimeFirst);
	});

	it('skips downstream manifest entirely when nothing forced and not first cycle', async () => {
		const token = makePackageProducer('token', '0xpkg1');
		const generate = manifest({ packages: [token.get('package')] });
		const engine = new Engine({ stack: [generate] }, { env: envFor() });

		await engine.runOnce();
		const result = await engine.cycle(); // empty work set
		expect(result.ran).toEqual([]);
		expect(result.skipped).toEqual([]);
	});

	it('re-fires when an upstream package changes', async () => {
		// Custom producer that mutates between cycles via prior-state inputs:
		type S = { name: string; packageId: string; rev: number };
		const token = define<S>({
			name: 'pkg.token',
			provides: { package: dep((s: S): Package => ({ name: s.name, packageId: s.packageId })) },
			inputs: ({ env }) => ({ rev: (env as { rev?: number }).rev ?? 0 }),
			start: async ({ env }) => {
				const rev = (env as { rev?: number }).rev ?? 0;
				return { name: 'token', packageId: `0xpkg-rev${rev}`, rev };
			},
		});
		const generate = manifest({ packages: [token.get('package')] });
		const env = envFor();
		const engine = new Engine({ stack: [generate] }, { env });

		await engine.runOnce();
		const path = join(appDir, 'src/generated/manifest.ts');
		const first = await readFile(path, 'utf8');
		expect(first).toContain('0xpkg-rev0');

		// Bump rev on the env — token's `inputs` callback flips the input
		// hash, token re-runs, manifest re-fires through cascade.
		(env as { rev?: number }).rev = 1;
		engine.invalidate('pkg.token');
		await engine.cycle();
		const second = await readFile(path, 'utf8');
		expect(second).toContain('0xpkg-rev1');
		expect(second).not.toContain('0xpkg-rev0');
	});

	it('honors a custom output path (relative to env.appDir)', async () => {
		const token = makePackageProducer('token', '0xpkg1');
		const generate = manifest({
			packages: [token.get('package')],
			output: 'custom/dir/manifest.ts',
		});
		const engine = new Engine({ stack: [generate] }, { env: envFor() });
		await engine.runOnce();
		const body = await readFile(join(appDir, 'custom/dir/manifest.ts'), 'utf8');
		expect(body).toContain('"name": "token"');
	});

	it('honors absolute output paths', async () => {
		const token = makePackageProducer('token', '0xpkg1');
		const absPath = join(appDir, 'absolute/manifest.ts');
		const generate = manifest({ packages: [token.get('package')], output: absPath });
		const engine = new Engine({ stack: [generate] }, { env: envFor() });
		await engine.runOnce();
		const body = await readFile(absPath, 'utf8');
		expect(body).toContain('"name": "token"');
	});
});
