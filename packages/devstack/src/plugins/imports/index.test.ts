import { beforeEach, describe, expect, it, vi } from 'vitest';

const imageExistsMock = vi.hoisted(() => vi.fn());
const ensureUpstreamSourceImageMock = vi.hoisted(() => vi.fn());
const importMovePackageMock = vi.hoisted(() => vi.fn());
const getChainIdentifierMock = vi.hoisted(() => vi.fn());
const getObjectMock = vi.hoisted(() => vi.fn());

vi.mock('../sui/docker.js', async () => {
	const actual = await vi.importActual<typeof import('../sui/docker.js')>('../sui/docker.js');
	return { ...actual, imageExists: imageExistsMock };
});

vi.mock('../../helpers/upstream-source.js', async () => {
	const actual = await vi.importActual<typeof import('../../helpers/upstream-source.js')>(
		'../../helpers/upstream-source.js',
	);
	return { ...actual, ensureUpstreamSourceImage: ensureUpstreamSourceImageMock };
});

vi.mock('../../helpers/imported-package.js', async () => {
	const actual = await vi.importActual<typeof import('../../helpers/imported-package.js')>(
		'../../helpers/imported-package.js',
	);
	return { ...actual, importMovePackage: importMovePackageMock };
});

vi.mock('@mysten/sui/jsonRpc', () => ({
	SuiJsonRpcClient: vi.fn().mockImplementation(() => ({
		getChainIdentifier: getChainIdentifierMock,
		getObject: getObjectMock,
	})),
}));

import type { Signer } from '@mysten/sui/cryptography';
import type {
	AccountsContext,
	ActionRunContext,
	BuildAction,
	Network,
	PublishAction,
} from '../../core/types.js';
import { expandPluginActions } from '../../plugin.js';
import { RegistryImpl } from '../../registry/index.js';
import { imports } from './index.js';

const fakeSigner = {
	toSuiAddress: () => '0xpub',
	getSecretKey: () => 'suiprivkey1...',
} as unknown as Signer;

const accountsWith = (entries: Record<string, Signer>): AccountsContext => ({
	get: (name) => {
		const s = entries[name];
		if (s === undefined) throw new Error(`accounts.get('${name}'): not in fixture`);
		return s;
	},
	has: (name) => name in entries,
	names: () => Object.keys(entries),
});

const makeCtx = (
	registry: RegistryImpl,
	network: Network = 'localnet',
	accounts: AccountsContext = accountsWith({ publisher: fakeSigner }),
): ActionRunContext => ({
	appName: 'wallet',
	appDir: '/tmp/wallet',
	stack: 'main',
	network,
	registry,
	accounts,
});

const setupRegistry = (): RegistryImpl => {
	const registry = new RegistryImpl();
	registry.services.register({ name: 'sui-rpc', kind: 'rpc', url: 'http://x', port: 1 });
	return registry;
};

beforeEach(() => {
	imageExistsMock.mockReset();
	ensureUpstreamSourceImageMock.mockReset();
	importMovePackageMock.mockReset();
	getChainIdentifierMock.mockReset();
	getObjectMock.mockReset();
});

describe('imports plugin — shape', () => {
	it('emits one Build + one Publish per package, with provides on the Publish', () => {
		const plugin = imports({
			packages: [
				{
					name: 'deepbook',
					repo: 'MystenLabs/deepbookv3',
					rev: 'v7.0.0',
					subdir: 'packages/deepbook',
				},
			],
		});
		const actions = expandPluginActions([plugin]);
		expect(actions.map((a) => `${a.type}:${a.name}`)).toEqual([
			'Build:imports.deepbook-source',
			'Publish:imports.deepbook',
		]);
		const publish = actions[1] as PublishAction;
		expect(publish.provides).toEqual(['imports.deepbook']);
		expect(publish.needs).toEqual(['imports.deepbook-source', 'sui.accounts']);
		expect(publish.path).toBe('<imported>');
	});

	it('emits actions for multiple packages, each with their own Build/Publish pair', () => {
		const plugin = imports({
			packages: [
				{
					name: 'deepbook',
					repo: 'MystenLabs/deepbookv3',
					rev: 'v7.0.0',
					subdir: 'packages/deepbook',
				},
				{ name: 'pyth', repo: 'pyth-network/pyth-crosschain', rev: 'main', subdir: 'pyth/sui' },
			],
		});
		const actions = expandPluginActions([plugin]);
		expect(actions.map((a) => a.name)).toEqual([
			'imports.deepbook-source',
			'imports.deepbook',
			'imports.pyth-source',
			'imports.pyth',
		]);
	});

	it('rejects duplicate package names at construction', () => {
		expect(() =>
			imports({
				packages: [
					{ name: 'deepbook', repo: 'a/a', rev: 'v1', subdir: '.' },
					{ name: 'deepbook', repo: 'b/b', rev: 'v2', subdir: '.' },
				],
			}),
		).toThrow(/duplicate package name 'deepbook'/);
	});

	it('rejects invalid (non-kebab) package names', () => {
		expect(() =>
			imports({ packages: [{ name: 'DeepBook', repo: 'a/a', rev: 'v1', subdir: '.' }] }),
		).toThrow(/invalid package name 'DeepBook'/);
		expect(() =>
			imports({ packages: [{ name: 'deep.book', repo: 'a/a', rev: 'v1', subdir: '.' }] }),
		).toThrow(/invalid package name 'deep.book'/);
	});

	it('records spec inputs on the Publish action for input hashing', () => {
		const plugin = imports({
			packages: [
				{
					name: 'deepbook',
					repo: 'MystenLabs/deepbookv3',
					rev: 'v7.0.0',
					subdir: 'packages/deepbook',
					addresses: { testnet: '0xdee9' },
				},
			],
		});
		const publish = expandPluginActions([plugin])[1] as PublishAction;
		expect(publish.inputs).toMatchObject({
			repo: 'MystenLabs/deepbookv3',
			rev: 'v7.0.0',
			subdir: 'packages/deepbook',
			env: 'localnet',
			publisher: 'publisher',
			addresses: { testnet: '0xdee9' },
		});
	});
});

describe('imports plugin — Build action', () => {
	const plugin = imports({
		packages: [
			{
				name: 'deepbook',
				repo: 'MystenLabs/deepbookv3',
				rev: 'v7.0.0',
				subdir: 'packages/deepbook',
				addresses: { testnet: '0xdee9testnet' },
			},
		],
	});
	const build = expandPluginActions([plugin])[0] as BuildAction;

	it('localnet: getStatus reports image presence', async () => {
		imageExistsMock.mockResolvedValueOnce(true);
		expect(await build.getStatus?.(makeCtx(new RegistryImpl(), 'localnet'))).toEqual({
			ok: true,
			detail: expect.stringContaining('upstream-source:MystenLabs__deepbookv3-v7.0.0'),
		});
		imageExistsMock.mockResolvedValueOnce(false);
		expect(await build.getStatus?.(makeCtx(new RegistryImpl(), 'localnet'))).toMatchObject({
			ok: false,
		});
	});

	it('live net with curated address: getStatus is ok and run is a no-op', async () => {
		const status = await build.getStatus?.(makeCtx(new RegistryImpl(), 'testnet'));
		expect(status?.ok).toBe(true);
		expect(status?.detail).toMatch(/curated/);
		await build.run?.(makeCtx(new RegistryImpl(), 'testnet'));
		expect(ensureUpstreamSourceImageMock).not.toHaveBeenCalled();
	});

	it('live net without curated address: falls through to image build', async () => {
		const noAddrPlugin = imports({
			packages: [{ name: 'deepbook', repo: 'a/a', rev: 'v1', subdir: '.' }],
		});
		const noAddrBuild = expandPluginActions([noAddrPlugin])[0] as BuildAction;
		imageExistsMock.mockResolvedValueOnce(false);
		expect((await noAddrBuild.getStatus?.(makeCtx(new RegistryImpl(), 'testnet')))?.ok).toBe(false);
		await noAddrBuild.run?.(makeCtx(new RegistryImpl(), 'testnet'));
		expect(ensureUpstreamSourceImageMock).toHaveBeenCalledTimes(1);
	});

	it('localnet run calls ensureUpstreamSourceImage', async () => {
		await build.run?.(makeCtx(new RegistryImpl(), 'localnet'));
		expect(ensureUpstreamSourceImageMock).toHaveBeenCalledWith({
			repo: 'MystenLabs/deepbookv3',
			rev: 'v7.0.0',
		});
	});
});

describe('imports plugin — Publish getStatus', () => {
	const plugin = imports({
		packages: [
			{
				name: 'deepbook',
				repo: 'MystenLabs/deepbookv3',
				rev: 'v7.0.0',
				subdir: 'packages/deepbook',
				addresses: { testnet: '0xdee9testnet' },
			},
		],
	});
	const publish = expandPluginActions([plugin])[1] as PublishAction;

	it('localnet: returns ok=false when no prior import exists', async () => {
		const status = await publish.getStatus?.(makeCtx(setupRegistry(), 'localnet'));
		expect(status).toEqual({ ok: false, detail: 'no prior import' });
	});

	it('localnet: returns ok=false when chainId differs from prior', async () => {
		const registry = setupRegistry();
		registry.packages.register({
			name: 'deepbook',
			packageId: '0xpkg',
			captured: {},
			sourceDigest: 'v7.0.0',
			chainId: 'chain-old',
			network: 'localnet',
		});
		getChainIdentifierMock.mockResolvedValue('chain-new');
		const status = await publish.getStatus?.(makeCtx(registry, 'localnet'));
		expect(status?.ok).toBe(false);
	});

	it('localnet: returns ok=true when package + deps are live on chain', async () => {
		const registry = setupRegistry();
		registry.packages.register({
			name: 'deepbook',
			packageId: '0xpkg',
			captured: {},
			deps: { deep: '0xdeep' },
			sourceDigest: 'v7.0.0',
			chainId: 'chain-1',
			network: 'localnet',
		});
		getChainIdentifierMock.mockResolvedValue('chain-1');
		getObjectMock.mockResolvedValue({ data: { objectId: 'x' } });
		const status = await publish.getStatus?.(makeCtx(registry, 'localnet'));
		expect(status).toEqual({ ok: true, detail: '0xpkg' });
		// One call for the package, one for the `deep` dep.
		expect(getObjectMock).toHaveBeenCalledTimes(2);
	});

	it('localnet: returns ok=false when an auto-published dep is missing on chain', async () => {
		const registry = setupRegistry();
		registry.packages.register({
			name: 'deepbook',
			packageId: '0xpkg',
			captured: {},
			deps: { deep: '0xdeep' },
			sourceDigest: 'v7.0.0',
			chainId: 'chain-1',
			network: 'localnet',
		});
		getChainIdentifierMock.mockResolvedValue('chain-1');
		// Package exists; dep is gone.
		getObjectMock
			.mockResolvedValueOnce({ data: { objectId: '0xpkg' } })
			.mockResolvedValueOnce({ data: null });
		const status = await publish.getStatus?.(makeCtx(registry, 'localnet'));
		expect(status?.ok).toBe(false);
		expect(status?.detail).toMatch(/dep deep/);
	});

	it('live net with curated address: returns ok and registers the curated id', async () => {
		const registry = setupRegistry();
		const status = await publish.getStatus?.(makeCtx(registry, 'testnet'));
		expect(status?.ok).toBe(true);
		expect(status?.detail).toMatch(/curated/);
		expect(registry.packages.find('deepbook')).toMatchObject({
			packageId: '0xdee9testnet',
			network: 'testnet',
		});
		// No on-chain probe — curated path skips it entirely.
		expect(getChainIdentifierMock).not.toHaveBeenCalled();
	});

	it('live net with curated address: skips re-register when already current', async () => {
		const registry = setupRegistry();
		registry.packages.register({
			name: 'deepbook',
			packageId: '0xdee9testnet',
			captured: {},
			network: 'testnet',
		});
		await publish.getStatus?.(makeCtx(registry, 'testnet'));
		// Still one entry, unchanged.
		expect(registry.packages.list().filter((p) => p.name === 'deepbook')).toHaveLength(1);
	});
});

describe('imports plugin — Publish run', () => {
	it('localnet: invokes importMovePackage and registers the result', async () => {
		const plugin = imports({
			packages: [
				{
					name: 'deepbook',
					repo: 'MystenLabs/deepbookv3',
					rev: 'v7.0.0',
					subdir: 'packages/deepbook',
					capture: { adminCapId: '::registry::DeepbookAdminCap' },
				},
			],
		});
		const publish = expandPluginActions([plugin])[1] as PublishAction;
		const registry = setupRegistry();
		getChainIdentifierMock.mockResolvedValue('chain-1');
		importMovePackageMock.mockResolvedValue({
			packageId: '0xfreshpkg',
			captured: { adminCapId: '0xcap' },
			deps: { deep: '0xdeep' },
			sourceDigest: 'v7.0.0',
			cacheHit: false,
		});

		await publish.run?.(makeCtx(registry, 'localnet'));

		expect(importMovePackageMock).toHaveBeenCalledTimes(1);
		const call = importMovePackageMock.mock.calls[0]?.[0];
		expect(call).toMatchObject({
			repo: 'MystenLabs/deepbookv3',
			rev: 'v7.0.0',
			subdir: 'packages/deepbook',
			alias: 'deepbook',
			chainId: 'chain-1',
			capture: { adminCapId: '::registry::DeepbookAdminCap' },
			env: 'localnet',
		});
		expect(registry.packages.find('deepbook')).toMatchObject({
			packageId: '0xfreshpkg',
			deps: { deep: '0xdeep' },
			chainId: 'chain-1',
			network: 'localnet',
		});
	});

	it('live net with curated address: registers curated id without calling importMovePackage', async () => {
		const plugin = imports({
			packages: [
				{
					name: 'deepbook',
					repo: 'MystenLabs/deepbookv3',
					rev: 'v7.0.0',
					subdir: 'packages/deepbook',
					addresses: { mainnet: '0xdee9mainnet' },
				},
			],
		});
		const publish = expandPluginActions([plugin])[1] as PublishAction;
		const registry = setupRegistry();

		await publish.run?.(makeCtx(registry, 'mainnet'));

		expect(importMovePackageMock).not.toHaveBeenCalled();
		expect(registry.packages.find('deepbook')).toMatchObject({
			packageId: '0xdee9mainnet',
			network: 'mainnet',
		});
	});

	it('live net without curated address: throws (importMovePackage requires the in-container sui CLI)', async () => {
		const plugin = imports({
			packages: [{ name: 'deepbook', repo: 'a/a', rev: 'v1', subdir: '.' }],
		});
		const publish = expandPluginActions([plugin])[1] as PublishAction;
		const registry = setupRegistry();

		await expect(publish.run?.(makeCtx(registry, 'testnet'))).rejects.toThrow(
			/requires localnet but got testnet/,
		);
		expect(importMovePackageMock).not.toHaveBeenCalled();
	});

	it('localnet: forwards prior cache entry when registry has a complete prior', async () => {
		const plugin = imports({
			packages: [{ name: 'deepbook', repo: 'a/a', rev: 'v2', subdir: '.' }],
		});
		const publish = expandPluginActions([plugin])[1] as PublishAction;
		const registry = setupRegistry();
		registry.packages.register({
			name: 'deepbook',
			packageId: '0xprior',
			captured: { capId: '0xcap' },
			deps: { deep: '0xdeep' },
			sourceDigest: 'v1',
			chainId: 'chain-1',
			network: 'localnet',
		});
		getChainIdentifierMock.mockResolvedValue('chain-1');
		importMovePackageMock.mockResolvedValue({
			packageId: '0xnew',
			captured: {},
			deps: {},
			sourceDigest: 'v2',
			cacheHit: false,
		});

		await publish.run?.(makeCtx(registry, 'localnet'));

		const call = importMovePackageMock.mock.calls[0]?.[0];
		expect(call?.prior).toEqual({
			packageId: '0xprior',
			captured: { capId: '0xcap' },
			deps: { deep: '0xdeep' },
			sourceDigest: 'v1',
			chainId: 'chain-1',
		});
	});
});
