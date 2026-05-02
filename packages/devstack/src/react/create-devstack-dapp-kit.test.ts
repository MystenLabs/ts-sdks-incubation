import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const createDAppKitMock = vi.hoisted(() => vi.fn());
const SuiGrpcClientCtor = vi.hoisted(() => vi.fn());

vi.mock('@mysten/dapp-kit-core', () => ({
	createDAppKit: createDAppKitMock,
}));
vi.mock('@mysten/sui/grpc', () => ({
	SuiGrpcClient: SuiGrpcClientCtor,
}));

import { createDevstackDappKit, localnetDappKitConfig } from './create-devstack-dapp-kit.js';

beforeEach(() => {
	createDAppKitMock.mockReset();
	createDAppKitMock.mockImplementation((cfg) => ({ __dappKit: cfg }));
	SuiGrpcClientCtor.mockReset();
	SuiGrpcClientCtor.mockImplementation((args) => ({ __grpc: args }));
	delete (globalThis as { __devstackDAppKit__?: unknown }).__devstackDAppKit__;
});

afterEach(() => {
	delete (globalThis as { __devstackDAppKit__?: unknown }).__devstackDAppKit__;
});

describe('createDevstackDappKit', () => {
	it('passes default localnet network and uses localnetRpcUrl for the gRPC client', () => {
		createDevstackDappKit({ localnetRpcUrl: 'http://127.0.0.1:9000' });
		const cfg = createDAppKitMock.mock.calls[0]?.[0] as {
			networks: string[];
			defaultNetwork: string;
			createClient: (n: string) => unknown;
		};
		expect(cfg.networks).toEqual(['localnet']);
		expect(cfg.defaultNetwork).toBe('localnet');
		cfg.createClient('localnet');
		expect(SuiGrpcClientCtor).toHaveBeenCalledWith({
			network: 'localnet',
			baseUrl: 'http://127.0.0.1:9000',
		});
	});

	it('throws when createClient runs against a network with no rpcUrl', () => {
		createDevstackDappKit({
			defaultNetwork: 'testnet',
			networks: { testnet: 'https://testnet.example' },
		});
		const cfg = createDAppKitMock.mock.calls[0]?.[0] as {
			createClient: (n: string) => unknown;
		};
		expect(() => cfg.createClient('mainnet')).toThrow(/no RPC URL for network 'mainnet'/);
	});

	it('forwards additionalNetworks and dedupes', () => {
		createDevstackDappKit({
			defaultNetwork: 'localnet',
			additionalNetworks: ['testnet', 'localnet'],
			localnetRpcUrl: 'http://x',
			networks: { testnet: 'http://t' },
		});
		const cfg = createDAppKitMock.mock.calls[0]?.[0] as { networks: string[] };
		expect(cfg.networks).toEqual(['localnet', 'testnet']);
	});

	it('passes walletInitializers through to dapp-kit', () => {
		const sentinel = { __init: 'devstack' };
		createDevstackDappKit({
			localnetRpcUrl: 'http://x',
			walletInitializers: [sentinel],
		});
		const cfg = createDAppKitMock.mock.calls[0]?.[0] as { walletInitializers: unknown[] };
		expect(cfg.walletInitializers).toEqual([sentinel]);
	});

	it('defaults walletInitializers to []', () => {
		createDevstackDappKit({ localnetRpcUrl: 'http://x' });
		const cfg = createDAppKitMock.mock.calls[0]?.[0] as { walletInitializers: unknown[] };
		expect(cfg.walletInitializers).toEqual([]);
	});

	it('exposes dAppKit on globalThis.__devstackDAppKit__ for the sign hook', () => {
		const { dAppKit } = createDevstackDappKit({ localnetRpcUrl: 'http://x' });
		expect((globalThis as { __devstackDAppKit__?: unknown }).__devstackDAppKit__).toBe(dAppKit);
	});

	it('runs the extend hook on the constructed config', () => {
		createDevstackDappKit({
			localnetRpcUrl: 'http://x',
			extend: (cfg) => ({ ...(cfg as object), enableBurnerWallet: false }) as typeof cfg,
		});
		const cfg = createDAppKitMock.mock.calls[0]?.[0] as { enableBurnerWallet: boolean };
		expect(cfg.enableBurnerWallet).toBe(false);
	});
});

describe('localnetDappKitConfig', () => {
	const manifestWith = (rpcUrl: string) => ({
		registry: { services: [{ name: 'sui-rpc', url: rpcUrl }] },
	});

	it('reads the sui-rpc URL out of the manifest', () => {
		const cfg = localnetDappKitConfig(manifestWith('http://127.0.0.1:9000'));
		expect(cfg.networks).toEqual(['localnet']);
		expect(cfg.defaultNetwork).toBe('localnet');
		cfg.createClient('localnet');
		expect(SuiGrpcClientCtor).toHaveBeenCalledWith({
			network: 'localnet',
			baseUrl: 'http://127.0.0.1:9000',
		});
	});

	it('localnetRpcUrl override wins over the manifest', () => {
		const cfg = localnetDappKitConfig(manifestWith('http://from-manifest'), {
			localnetRpcUrl: 'http://override',
		});
		cfg.createClient('localnet');
		expect(SuiGrpcClientCtor).toHaveBeenCalledWith({
			network: 'localnet',
			baseUrl: 'http://override',
		});
	});

	it('throws when neither manifest nor override has a URL', () => {
		expect(() => localnetDappKitConfig({})).toThrow(/no localnetRpcUrl provided and no `sui-rpc`/);
	});

	it('forwards additionalNetworks deduped, with explicit per-network URLs', () => {
		const cfg = localnetDappKitConfig(manifestWith('http://localhost:9000'), {
			additionalNetworks: ['testnet', 'localnet'],
			networks: { testnet: 'https://testnet.example' },
		});
		expect(cfg.networks).toEqual(['localnet', 'testnet']);
		cfg.createClient('testnet');
		expect(SuiGrpcClientCtor).toHaveBeenLastCalledWith({
			network: 'testnet',
			baseUrl: 'https://testnet.example',
		});
	});

	it('throws when createClient runs against a network that has no URL', () => {
		const cfg = localnetDappKitConfig(manifestWith('http://localhost:9000'), {
			additionalNetworks: ['testnet'],
		});
		expect(() => cfg.createClient('testnet')).toThrow(/no RPC URL for network 'testnet'/);
	});
});
