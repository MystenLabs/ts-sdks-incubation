import { beforeEach, describe, expect, it, vi } from 'vitest';

const SuiGrpcClientCtor = vi.hoisted(() => vi.fn());

vi.mock('@mysten/sui/grpc', () => ({
	SuiGrpcClient: SuiGrpcClientCtor,
}));

import { localnetDappKitConfig, localnetMvrOverrides } from './create-devstack-dapp-kit.js';

beforeEach(() => {
	SuiGrpcClientCtor.mockReset();
	SuiGrpcClientCtor.mockImplementation((args) => ({ __grpc: args }));
});

describe('localnetDappKitConfig', () => {
	const manifestWith = (
		rpcUrl: string,
		extras: {
			packages?: Array<{ name: string; packageId: string; mvrPlaceholder?: string }>;
		} = {},
	) => ({
		registry: { services: [{ name: 'sui-rpc', url: rpcUrl }], ...extras },
	});

	it('reads the sui-rpc URL out of the manifest', () => {
		const cfg = localnetDappKitConfig(manifestWith('http://127.0.0.1:9000'));
		expect(cfg.networks).toEqual(['localnet']);
		expect(cfg.defaultNetwork).toBe('localnet');
		cfg.createClient('localnet');
		expect(SuiGrpcClientCtor).toHaveBeenCalledWith({
			network: 'localnet',
			baseUrl: 'http://127.0.0.1:9000',
			mvr: undefined,
		});
	});

	it('passes manifest packages through as MVR overrides on localnet', () => {
		const cfg = localnetDappKitConfig(
			manifestWith('http://localhost:9000', {
				packages: [
					{ name: 'connect_four', packageId: '0xabc', mvrPlaceholder: '@local/connect-four' },
					{ name: 'mock_usdc', packageId: '0xdef', mvrPlaceholder: '@local/mock-usdc' },
				],
			}),
		);
		cfg.createClient('localnet');
		expect(SuiGrpcClientCtor).toHaveBeenCalledWith({
			network: 'localnet',
			baseUrl: 'http://localhost:9000',
			mvr: {
				overrides: {
					packages: {
						'@local/connect-four': '0xabc',
						'@local/mock-usdc': '0xdef',
					},
				},
			},
		});
	});

	it('does NOT apply MVR overrides on non-localnet networks', () => {
		const cfg = localnetDappKitConfig(
			manifestWith('http://localhost:9000', {
				packages: [
					{ name: 'connect_four', packageId: '0xabc', mvrPlaceholder: '@local/connect-four' },
				],
			}),
			{
				additionalNetworks: ['testnet'],
				networks: { testnet: 'https://testnet.example' },
			},
		);
		cfg.createClient('testnet');
		expect(SuiGrpcClientCtor).toHaveBeenLastCalledWith({
			network: 'testnet',
			baseUrl: 'https://testnet.example',
			mvr: undefined,
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
			mvr: undefined,
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
	});

	it('throws when createClient runs against a network that has no URL', () => {
		const cfg = localnetDappKitConfig(manifestWith('http://localhost:9000'), {
			additionalNetworks: ['testnet'],
		});
		expect(() => cfg.createClient('testnet')).toThrow(/no RPC URL for network 'testnet'/);
	});
});

describe('localnetMvrOverrides', () => {
	it('reads each package\'s mvrPlaceholder from the manifest', () => {
		const m = {
			registry: {
				packages: [
					{ name: 'connect_four', packageId: '0xabc', mvrPlaceholder: '@local/connect-four' },
					{ name: 'mock_usdc', packageId: '0xdef', mvrPlaceholder: '@local/mock-usdc' },
				],
			},
		};
		expect(localnetMvrOverrides(m)).toEqual({
			packages: {
				'@local/connect-four': '0xabc',
				'@local/mock-usdc': '0xdef',
			},
		});
	});

	it('skips packages with no mvrPlaceholder', () => {
		const m = {
			registry: {
				packages: [
					{ name: 'walrus', packageId: '0x123' },
					{ name: 'vault', packageId: '0xabc', mvrPlaceholder: '@local/vault' },
				],
			},
		};
		expect(localnetMvrOverrides(m)).toEqual({
			packages: { '@local/vault': '0xabc' },
		});
	});

	it('returns an empty packages map for an empty / missing manifest', () => {
		expect(localnetMvrOverrides(undefined)).toEqual({ packages: {} });
		expect(localnetMvrOverrides({})).toEqual({ packages: {} });
		expect(localnetMvrOverrides({ registry: {} })).toEqual({ packages: {} });
	});

	it('honors a custom placeholder shape published by the codegen plugin', () => {
		const m = {
			registry: {
				packages: [
					{ name: 'connect_four', packageId: '0xabc', mvrPlaceholder: '@arena/connect-four' },
				],
			},
		};
		expect(localnetMvrOverrides(m)).toEqual({
			packages: { '@arena/connect-four': '0xabc' },
		});
	});
});
