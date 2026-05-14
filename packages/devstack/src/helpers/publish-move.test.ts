import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Engine } from '../engine/class.js';
import type { Env } from '../engine/types.js';
import { dep } from '../factories/dep.js';
import { define } from '../factories/define.js';
import { sui } from '../plugins/sui.js';
import { manifest } from '../plugins/manifest.js';
import type { Package } from '../shapes/index.js';
import { hashMoveTree, publishMove } from './publish-move.js';

let appDir: string;

beforeEach(async () => {
	appDir = await mkdtemp(join(tmpdir(), 'devstack-publish-'));
});

afterEach(async () => {
	await rm(appDir, { recursive: true, force: true });
});

const baseEnv = (): Env => ({
	appName: 'demo',
	appDir,
	network: 'localnet',
	stack: 'main',
});

// Synthetic signer producer — stand-in for accountPool.get('signer', ...).
function makeSigner(name: string, address: string) {
	type S = { name: string; address: string };
	return define({
		name: `acc.${name}`,
		provides: { signer: dep((s: S) => ({ name: s.name, address: s.address })) },
		start: async () => ({ name, address }),
	});
}

async function writeMoveSources(
	root: string,
	files: Record<string, string>,
): Promise<void> {
	const fs = await import('node:fs/promises');
	for (const [path, body] of Object.entries(files)) {
		const full = join(root, path);
		await fs.mkdir(join(full, '..'), { recursive: true });
		await writeFile(full, body, 'utf8');
	}
}

describe('hashMoveTree', () => {
	it('returns empty string when path does not exist', () => {
		expect(hashMoveTree(join(appDir, 'nope'))).toBe('');
	});

	it('hashes Move.toml + .move sources, ignores build/', async () => {
		const root = join(appDir, 'pkg');
		await writeMoveSources(root, {
			'Move.toml': '[package]\nname = "pkg"',
			'sources/m1.move': 'module pkg::m1 {}',
			'sources/m2.move': 'module pkg::m2 {}',
			'build/junk': 'should not be hashed',
		});
		const h1 = hashMoveTree(root);
		expect(h1).toMatch(/^[0-9a-f]{16}$/);

		await writeFile(join(root, 'build/more-junk'), 'still ignored', 'utf8');
		expect(hashMoveTree(root)).toBe(h1);

		await writeFile(join(root, 'sources/m1.move'), 'module pkg::m1 { fun x() {} }', 'utf8');
		expect(hashMoveTree(root)).not.toBe(h1);
	});
});

describe('publishMove', () => {
	it('runs publish callback with sourcePath, signer, rpcUrl, sourceHash', async () => {
		const root = join(appDir, 'move/token');
		await writeMoveSources(root, {
			'Move.toml': '[package]\nname = "token"',
			'sources/token.move': 'module token::token {}',
		});

		const acc = makeSigner('publisher', '0x111');
		let captured:
			| {
					sourcePath: string;
					signer: { address: string };
					rpcUrl: string;
					sourceHash: string;
			  }
			| undefined;

		const token = publishMove({
			name: 'token',
			path: 'move/token',
			signer: acc.get('signer'),
			publish: async (ctx) => {
				captured = ctx;
				return { packageId: '0xpkg-token' };
			},
		});

		const engine = new Engine(
			{ stack: [sui.create({ network: 'testnet' }), token] },
			{ env: baseEnv() },
		);
		const result = await engine.runOnce();
		expect(result.errored).toEqual([]);
		expect(captured).toBeDefined();
		expect(captured!.sourcePath).toBe(root);
		expect(captured!.signer.address).toBe('0x111');
		expect(captured!.rpcUrl).toContain('testnet.sui.io');
		expect(captured!.sourceHash).toMatch(/^[0-9a-f]{16}$/);
	});

	it('skips re-publish when source + rpcUrl + signer all unchanged', async () => {
		const root = join(appDir, 'move/token');
		await writeMoveSources(root, {
			'Move.toml': '[package]\nname = "token"',
			'sources/token.move': 'module token::token {}',
		});

		const acc = makeSigner('publisher', '0x111');
		let publishCount = 0;
		const token = publishMove({
			name: 'token',
			path: 'move/token',
			signer: acc.get('signer'),
			publish: async () => {
				publishCount += 1;
				return { packageId: `0xpkg-${publishCount}` };
			},
		});
		const engine = new Engine(
			{ stack: [sui.create({ network: 'testnet' }), token] },
			{ env: baseEnv() },
		);
		await engine.runOnce();
		expect(publishCount).toBe(1);

		// Force a cycle by invalidating an unrelated upstream — sui's
		// state hasn't changed, so token's input hash stays the same and
		// run() should not fire even though it's in the work set.
		engine.invalidate('sui.testnet');
		await engine.cycle();
		expect(publishCount).toBe(1);
	});

	it('re-fires when Move source changes', async () => {
		const root = join(appDir, 'move/token');
		await writeMoveSources(root, {
			'Move.toml': '[package]\nname = "token"',
			'sources/token.move': 'module token::token {}',
		});

		const acc = makeSigner('publisher', '0x111');
		let publishCount = 0;
		const token = publishMove({
			name: 'token',
			path: 'move/token',
			signer: acc.get('signer'),
			publish: async () => {
				publishCount += 1;
				return { packageId: `0xpkg-${publishCount}` };
			},
		});
		const engine = new Engine(
			{ stack: [sui.create({ network: 'testnet' }), token] },
			{ env: baseEnv() },
		);
		await engine.runOnce();
		expect(publishCount).toBe(1);

		// Edit a source file; force a cycle on token.
		await writeFile(
			join(root, 'sources/token.move'),
			'module token::token { fun new() {} }',
			'utf8',
		);
		engine.invalidate('publish.token');
		await engine.cycle();
		expect(publishCount).toBe(2);
	});

	it('exposes a Package-shape Dep that manifest can consume', async () => {
		const root = join(appDir, 'move/token');
		await writeMoveSources(root, {
			'Move.toml': '[package]\nname = "token"',
			'sources/token.move': 'module token::token {}',
		});

		const acc = makeSigner('publisher', '0x111');
		const token = publishMove({
			name: 'token',
			path: 'move/token',
			signer: acc.get('signer'),
			publish: async () => ({ packageId: '0xpkg-token' }),
		});
		const generate = manifest({ packages: [token.get('package')] });

		const engine = new Engine(
			{ stack: [sui.create({ network: 'testnet' }), generate] },
			{ env: baseEnv() },
		);
		await engine.runOnce();
		const fs = await import('node:fs/promises');
		const body = await fs.readFile(join(appDir, 'src/generated/manifest.ts'), 'utf8');
		expect(body).toContain('"name": "token"');
		expect(body).toContain('"packageId": "0xpkg-token"');
	});

	it('throws when publish source path does not exist', async () => {
		const acc = makeSigner('publisher', '0x111');
		const token = publishMove({
			name: 'token',
			path: 'move/missing',
			signer: acc.get('signer'),
			publish: async () => ({ packageId: '0xpkg' }),
		});
		const engine = new Engine(
			{ stack: [sui.create({ network: 'testnet' }), token] },
			{ env: baseEnv() },
		);
		const result = await engine.runOnce();
		const err = result.errored.find((e) => e.name === 'publish.token');
		expect(err).toBeDefined();
		expect(err!.error.message).toMatch(/source path does not exist/);
	});

	it('represents.packages projects per-package shape for the TUI', async () => {
		const root = join(appDir, 'move/token');
		await writeMoveSources(root, {
			'Move.toml': '',
			'sources/x.move': 'module token::x {}',
		});
		const acc = makeSigner('publisher', '0x111');
		const token = publishMove({
			name: 'token',
			path: 'move/token',
			signer: acc.get('signer'),
			publish: async () => ({ packageId: '0xpkg-token' }),
		});
		const engine = new Engine(
			{ stack: [sui.create({ network: 'testnet' }), token] },
			{ env: baseEnv() },
		);
		await engine.runOnce();
		const view = engine.getState().nodes.get('publish.token')!;
		const pkgs = view.representations?.packages as Package[] | undefined;
		expect(pkgs).toBeDefined();
		const pkg = pkgs![0]!;
		expect(pkg.name).toBe('token');
		expect(pkg.packageId).toBe('0xpkg-token');
		expect(pkg.mvrPlaceholder).toBe('@local/token');
		// `path` is an absolute on-host path; just check that it ends with the
		// configured relative path (env.appDir is a tmpdir).
		expect(pkg.path).toMatch(/move\/token$/);
	});

	it('defaults mvrPlaceholder to @local/<name>', async () => {
		const root = join(appDir, 'move/token');
		await writeMoveSources(root, {
			'Move.toml': '',
			'sources/x.move': 'module token::x {}',
		});
		const acc = makeSigner('publisher', '0x111');
		const token = publishMove({
			name: 'token',
			path: 'move/token',
			signer: acc.get('signer'),
			publish: async () => ({ packageId: '0xpkg' }),
		});
		const engine = new Engine(
			{ stack: [sui.create({ network: 'testnet' }), token] },
			{ env: baseEnv() },
		);
		await engine.runOnce();
		const view = engine.getState().nodes.get('publish.token')!;
		const pkgs = view.representations?.packages as Package[];
		expect(pkgs[0]?.mvrPlaceholder).toBe('@local/token');
	});

	it('honors a custom mvrPlaceholder', async () => {
		const root = join(appDir, 'move/token');
		await writeMoveSources(root, {
			'Move.toml': '',
			'sources/x.move': 'module token::x {}',
		});
		const acc = makeSigner('publisher', '0x111');
		const token = publishMove({
			name: 'token',
			path: 'move/token',
			signer: acc.get('signer'),
			publish: async () => ({ packageId: '0xpkg' }),
			mvrPlaceholder: '@my-org/token',
		});
		const engine = new Engine(
			{ stack: [sui.create({ network: 'testnet' }), token] },
			{ env: baseEnv() },
		);
		await engine.runOnce();
		const view = engine.getState().nodes.get('publish.token')!;
		const pkgs = view.representations?.packages as Package[];
		expect(pkgs[0]?.mvrPlaceholder).toBe('@my-org/token');
	});

	it('manifest emission strips path (no host filesystem leak)', async () => {
		const root = join(appDir, 'move/token');
		await writeMoveSources(root, {
			'Move.toml': '',
			'sources/x.move': 'module token::x {}',
		});
		const acc = makeSigner('publisher', '0x111');
		const token = publishMove({
			name: 'token',
			path: 'move/token',
			signer: acc.get('signer'),
			publish: async () => ({ packageId: '0xpkg' }),
		});
		const generate = manifest({ packages: [token.get('package')] });
		const engine = new Engine(
			{ stack: [sui.create({ network: 'testnet' }), token, generate] },
			{ env: baseEnv() },
		);
		await engine.runOnce();
		const fs = await import('node:fs/promises');
		const body = await fs.readFile(join(appDir, 'src/generated/manifest.ts'), 'utf8');
		// path stripped; mvrPlaceholder retained.
		expect(body).not.toContain('"path"');
		expect(body).not.toContain(appDir);
		expect(body).toContain('"mvrPlaceholder": "@local/token"');
	});

	it('preserves objects (TreasuryCap, etc.) in state', async () => {
		const root = join(appDir, 'move/token');
		await writeMoveSources(root, {
			'Move.toml': '',
			'sources/x.move': 'module token::x {}',
		});
		const acc = makeSigner('publisher', '0x111');
		const token = publishMove({
			name: 'token',
			path: 'move/token',
			signer: acc.get('signer'),
			publish: async () => ({
				packageId: '0xpkg',
				objects: { treasuryCap: '0xcap', upgradeCap: '0xupgrade' },
			}),
		});
		const engine = new Engine(
			{ stack: [sui.create({ network: 'testnet' }), token] },
			{ env: baseEnv() },
		);
		await engine.runOnce();
		const state = engine.getState().nodes.get('publish.token')!.state as {
			objects?: Record<string, string>;
		};
		expect(state.objects).toEqual({ treasuryCap: '0xcap', upgradeCap: '0xupgrade' });
	});
});
