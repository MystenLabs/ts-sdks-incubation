import { describe, expect, it, vi } from 'vitest';

const useDevstackContextMock = vi.hoisted(() => vi.fn());

vi.mock('./provider.js', () => ({
	useDevstackContext: useDevstackContextMock,
}));

import { useDevstackDeployed } from './use-devstack-deployed.js';

const ctx = (manifest: unknown) => {
	useDevstackContextMock.mockReturnValue({ manifest, packages: {} });
};

describe('useDevstackDeployed', () => {
	it('returns false when manifest is null', () => {
		ctx(null);
		expect(useDevstackDeployed()).toBe(false);
	});

	it('returns false when manifest has no accounts', () => {
		ctx({ registry: { accounts: [], packages: [{ name: 'foo' }] } });
		expect(useDevstackDeployed()).toBe(false);
	});

	it('returns true when manifest has at least one account + one package (default)', () => {
		ctx({
			registry: {
				accounts: [{ name: 'alice' }],
				packages: [{ name: 'foo' }],
			},
		});
		expect(useDevstackDeployed()).toBe(true);
	});

	it('returns false with default check when registry has accounts but no packages', () => {
		ctx({ registry: { accounts: [{ name: 'alice' }], packages: [] } });
		expect(useDevstackDeployed()).toBe(false);
	});

	it('returns true when every requirePackages name is present', () => {
		ctx({
			registry: {
				accounts: [{ name: 'alice' }],
				packages: [{ name: 'connect_four' }, { name: 'mock_usdc' }],
			},
		});
		expect(useDevstackDeployed({ requirePackages: ['connect_four', 'mock_usdc'] })).toBe(true);
	});

	it('returns false when any requirePackages name is missing', () => {
		ctx({
			registry: {
				accounts: [{ name: 'alice' }],
				packages: [{ name: 'connect_four' }],
			},
		});
		expect(useDevstackDeployed({ requirePackages: ['connect_four', 'managed_coin'] })).toBe(false);
	});

	it('handles a manifest with missing accounts/packages arrays gracefully', () => {
		ctx({ registry: {} });
		expect(useDevstackDeployed()).toBe(false);
	});
});
