import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const publishMovePackageMock = vi.hoisted(() => vi.fn());
const getChainIdentifierMock = vi.hoisted(() => vi.fn());
const getObjectMock = vi.hoisted(() => vi.fn());

vi.mock('../helpers/move-package.js', async () => {
	const actual = await vi.importActual<typeof import('../helpers/move-package.js')>(
		'../helpers/move-package.js',
	);
	return {
		...actual,
		publishMovePackage: publishMovePackageMock,
	};
});

vi.mock('@mysten/sui/jsonRpc', () => ({
	SuiJsonRpcClient: vi.fn().mockImplementation(() => ({
		getChainIdentifier: getChainIdentifierMock,
		getObject: getObjectMock,
	})),
}));

import { publish } from './publish.js';
import { RegistryImpl } from '../registry/index.js';
import type { AccountsContext, ActionRunContext, PublishAction } from '../core/types.js';
import { createInMemoryPortAllocator } from '../runtime/port-allocator.js';
import type { Signer } from '@mysten/sui/cryptography';

const fakeSigner = { toSuiAddress: () => '0xabc' } as unknown as Signer;

const accountsWith = (entries: Record<string, Signer>): AccountsContext => ({
	get: (name) => {
		const s = entries[name];
		if (s === undefined) {
			throw new Error(`accounts.get('${name}'): not in this fixture`);
		}
		return s;
	},
	has: (name) => name in entries,
	names: () => Object.keys(entries),
});

const makeCtx = (
	registry: RegistryImpl,
	accounts: AccountsContext = accountsWith({ publisher: fakeSigner }),
): ActionRunContext => ({
	appName: 'arena',
	appDir: '/tmp/arena',
	stack: 'main',
	network: 'localnet',
	registry,
	accounts,
	ports: createInMemoryPortAllocator(),
});

let tmpDirs: string[] = [];

const newMovePackageDir = (contents: Record<string, string> = {}): string => {
	const dir = mkdtempSync(join(tmpdir(), 'devstack-publish-'));
	tmpDirs.push(dir);
	writeFileSync(join(dir, 'Move.toml'), '[package]\nname = "test"\nedition = "2024"\n');
	for (const [name, body] of Object.entries(contents)) {
		writeFileSync(join(dir, name), body);
	}
	return dir;
};

beforeEach(() => {
	publishMovePackageMock.mockReset();
	getChainIdentifierMock.mockReset();
	getObjectMock.mockReset();
	tmpDirs = [];
});

afterEach(() => {
	for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

describe('publish — shape', () => {
	it('returns a PublishAction with no default getStatus (idempotence comes from input-hash + persisted state)', () => {
		const a = publish({
			name: 'connect_four',
			path: '/tmp/does-not-exist/move/connect_four',
			capture: { adminCap: '::admin::AdminCap' },
			provides: { capabilities: ['arena.game'] },
		});
		expect(a.type).toBe('Publish');
		expect(a.name).toBe('connect_four');
		expect(a.path).toBe('/tmp/does-not-exist/move/connect_four');
		expect(a.provides).toEqual({ capabilities: ['arena.game'] });
		expect(a.getStatus).toBeUndefined();
		expect(typeof a.run).toBe('function');
	});

	it('honors a custom publisher name in inputs', () => {
		const a = publish({
			name: 'pkg',
			path: '/tmp/does-not-exist/move/pkg',
			publisher: 'deployer',
		});
		expect(a.inputs).toMatchObject({ publisher: 'deployer' });
	});

	it('omits sourceDigest when path is relative (action expansion cannot resolve it)', () => {
		const a = publish({
			name: 'pkg',
			path: './move/pkg',
		});
		expect(a.inputs).toMatchObject({ path: './move/pkg', sourceDigest: undefined });
	});

	it('omits sourceDigest when path does not exist on host', () => {
		const a = publish({
			name: 'pkg',
			path: '/tmp/does-not-exist/move/pkg',
		});
		expect((a.inputs as { sourceDigest?: string }).sourceDigest).toBeUndefined();
	});

	it('omits sourceDigest when prepareSource is set (in-image source)', () => {
		const a = publish({
			name: 'pkg',
			path: '/will/be/replaced',
			prepareSource: async () => ({ dir: '/tmp/prepared' }),
		});
		expect((a.inputs as { sourceDigest?: string }).sourceDigest).toBeUndefined();
	});

	it('computes sourceDigest at action-construction time for absolute on-host paths', () => {
		const dir = newMovePackageDir();
		const a = publish({ name: 'pkg', path: dir });
		const digest = (a.inputs as { sourceDigest?: string }).sourceDigest;
		expect(digest).toMatch(/^[0-9a-f]{64}$/);
	});

	it('busts the action input hash when Move sources change between expansions', () => {
		const dir = newMovePackageDir();
		writeFileSync(join(dir, 'sources.move'), 'module test::a {}\n');
		const before = (
			publish({ name: 'pkg', path: dir }).inputs as { sourceDigest?: string }
		).sourceDigest;
		writeFileSync(join(dir, 'sources.move'), 'module test::a { public fun b() {} }\n');
		const after = (
			publish({ name: 'pkg', path: dir }).inputs as { sourceDigest?: string }
		).sourceDigest;
		expect(before).toMatch(/^[0-9a-f]{64}$/);
		expect(after).toMatch(/^[0-9a-f]{64}$/);
		expect(after).not.toBe(before);
	});
});

describe('publish — onPublished invocation', () => {
	const setup = () => {
		const registry = new RegistryImpl();
		registry.services.register({ name: 'sui-rpc', kind: 'rpc', url: 'http://x', port: 1 });
		getChainIdentifierMock.mockResolvedValue('chain-1');
		return registry;
	};

	it('fires onPublished after a fresh publish, with the publish result', async () => {
		const onPublished = vi.fn();
		const a = publish({
			name: 'connect_four',
			path: '/abs/move/connect_four',
			onPublished,
		}) as PublishAction;
		const registry = setup();
		publishMovePackageMock.mockResolvedValue({
			packageId: '0xnew',
			captured: { adminCap: '0xcap' },
			sourceDigest: 'bb',
			cacheHit: false,
		});

		await a.run?.(makeCtx(registry));

		expect(publishMovePackageMock).toHaveBeenCalledTimes(1);
		expect(onPublished).toHaveBeenCalledTimes(1);
		expect(onPublished.mock.calls[0]?.[1]).toMatchObject({ packageId: '0xnew', cacheHit: false });
		expect(registry.packages.find('connect_four')).toMatchObject({
			name: 'connect_four',
			packageId: '0xnew',
			chainId: 'chain-1',
		});
	});

	it('skips onPublished on a cache hit', async () => {
		const onPublished = vi.fn();
		const a = publish({
			name: 'connect_four',
			path: '/abs/move/connect_four',
			onPublished,
		}) as PublishAction;
		const registry = setup();
		publishMovePackageMock.mockResolvedValue({
			packageId: '0xold',
			captured: {},
			sourceDigest: 'aa',
			cacheHit: true,
		});

		await a.run?.(makeCtx(registry));

		expect(publishMovePackageMock).toHaveBeenCalledTimes(1);
		expect(onPublished).not.toHaveBeenCalled();
	});

	it('uses the configured publisher account name', async () => {
		const deployerSigner = { toSuiAddress: () => '0xdeployer' } as unknown as Signer;
		const a = publish({
			name: 'pkg',
			path: '/abs/pkg',
			publisher: 'deployer',
		}) as PublishAction;
		const registry = setup();
		publishMovePackageMock.mockResolvedValue({
			packageId: '0xpkg',
			captured: {},
			sourceDigest: 'cc',
			cacheHit: false,
		});

		await a.run?.(makeCtx(registry, accountsWith({ deployer: deployerSigner })));

		expect(publishMovePackageMock).toHaveBeenCalledTimes(1);
		expect(publishMovePackageMock.mock.calls[0]?.[0]).toMatchObject({ publisher: deployerSigner });
	});

	it('uses registryAs to override the registry entry name', async () => {
		const a = publish({
			name: 'pkg',
			path: '/abs/pkg',
			registryAs: 'custom_name',
		}) as PublishAction;
		const registry = setup();
		publishMovePackageMock.mockResolvedValue({
			packageId: '0xpkg',
			captured: {},
			sourceDigest: 'cc',
			cacheHit: false,
		});

		await a.run?.(makeCtx(registry));

		expect(registry.packages.find('custom_name')).toBeDefined();
		expect(registry.packages.find('pkg')).toBeUndefined();
	});
});
