import { beforeEach, describe, expect, it, vi } from 'vitest';

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

import { definePublishAction } from './publish.js';
import { RegistryImpl } from '../registry/index.js';
import type { AccountsContext, ActionRunContext, PublishAction } from '../core/types.js';
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
});

beforeEach(() => {
	publishMovePackageMock.mockReset();
	getChainIdentifierMock.mockReset();
	getObjectMock.mockReset();
});

describe('definePublishAction — shape', () => {
	it('returns a PublishAction with bare name + provides + auto-injected getStatus/run', () => {
		const a = definePublishAction({
			name: 'connect_four',
			sourcePath: './move/connect_four',
			capture: { adminCap: '::admin::AdminCap' },
			provides: ['arena-game'],
		});
		expect(a.type).toBe('Publish');
		expect(a.name).toBe('connect_four');
		expect(a.path).toBe('./move/connect_four');
		expect(a.provides).toEqual(['arena-game']);
		expect(a.inputs).toEqual({
			path: './move/connect_four',
			capture: { adminCap: '::admin::AdminCap' },
			publisher: 'publisher',
		});
		expect(typeof a.getStatus).toBe('function');
		expect(typeof a.run).toBe('function');
	});

	it('honors a custom publisher name in inputs', () => {
		const a = definePublishAction({
			name: 'pkg',
			sourcePath: './move/pkg',
			publisher: 'deployer',
		});
		expect(a.inputs).toMatchObject({ publisher: 'deployer' });
	});
});

describe('definePublishAction — default getStatus', () => {
	const action = definePublishAction({
		name: 'connect_four',
		sourcePath: './move/connect_four',
	}) as PublishAction;

	it('returns ok=false when no prior package is in the registry', async () => {
		const registry = new RegistryImpl();
		const result = await action.getStatus?.(makeCtx(registry));
		expect(result).toEqual({ ok: false, detail: 'no prior publish' });
		// No prior → no client constructed at all (early return).
		expect(getChainIdentifierMock).not.toHaveBeenCalled();
	});

	it('returns ok=false when chainId differs from the prior publish', async () => {
		const registry = new RegistryImpl();
		registry.services.register({ name: 'sui-rpc', kind: 'rpc', url: 'http://x', port: 1 });
		registry.packages.register({
			name: 'connect_four',
			packageId: '0xpkg',
			captured: {},
			sourceDigest: 'aa',
			chainId: 'chain-old',
			network: 'localnet',
		});
		getChainIdentifierMock.mockResolvedValue('chain-new');
		const result = await action.getStatus?.(makeCtx(registry));
		expect(result).toEqual({ ok: false, detail: 'chainId differs from prior publish' });
	});

	it('returns ok=true when the cached package is still on chain', async () => {
		const registry = new RegistryImpl();
		registry.services.register({ name: 'sui-rpc', kind: 'rpc', url: 'http://x', port: 1 });
		registry.packages.register({
			name: 'connect_four',
			packageId: '0xpkg',
			captured: {},
			sourceDigest: 'aa',
			chainId: 'chain-1',
			network: 'localnet',
		});
		getChainIdentifierMock.mockResolvedValue('chain-1');
		getObjectMock.mockResolvedValue({ data: { objectId: '0xpkg' } });
		const result = await action.getStatus?.(makeCtx(registry));
		expect(result).toEqual({ ok: true, detail: '0xpkg' });
	});
});

describe('definePublishAction — onPublished invocation', () => {
	const setup = () => {
		const registry = new RegistryImpl();
		registry.services.register({ name: 'sui-rpc', kind: 'rpc', url: 'http://x', port: 1 });
		getChainIdentifierMock.mockResolvedValue('chain-1');
		return registry;
	};

	it('fires onPublished after a fresh publish, with the publish result', async () => {
		const onPublished = vi.fn();
		const a = definePublishAction({
			name: 'connect_four',
			sourcePath: '/abs/move/connect_four',
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
		const a = definePublishAction({
			name: 'connect_four',
			sourcePath: '/abs/move/connect_four',
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
		const a = definePublishAction({
			name: 'pkg',
			sourcePath: '/abs/pkg',
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
		const a = definePublishAction({
			name: 'pkg',
			sourcePath: '/abs/pkg',
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
