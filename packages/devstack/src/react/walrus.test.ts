import { describe, expect, it } from 'vitest';
import { localnetWalrusOptions } from './walrus.js';

const manifestWith = (overrides: Record<string, unknown> = {}) => ({
	registry: {
		packages: [
			{
				name: 'walrus',
				packageId: '0xwalrus',
				captured: {
					systemObject: '0xsystem',
					stakingObject: '0xstaking',
				},
			},
		],
		...overrides,
	},
});

describe('localnetWalrusOptions', () => {
	it('returns systemObjectId + stakingPoolId from the manifest', () => {
		const opts = localnetWalrusOptions(manifestWith());
		expect(opts.packageConfig).toEqual({
			systemObjectId: '0xsystem',
			stakingPoolId: '0xstaking',
		});
	});

	it('returns storageNodeUrlScheme: http for devstack storage nodes', () => {
		expect(localnetWalrusOptions(manifestWith()).storageNodeUrlScheme).toBe('http');
	});

	it('throws when the walrus package is missing from the manifest', () => {
		expect(() => localnetWalrusOptions({ registry: { packages: [] } })).toThrow(
			/no `walrus` package in manifest/,
		);
	});

	it('throws when systemObject / stakingObject are not captured', () => {
		expect(() =>
			localnetWalrusOptions({
				registry: {
					packages: [{ name: 'walrus', packageId: '0xw', captured: {} }],
				},
			}),
		).toThrow(/missing systemObject\/stakingObject/);
	});
});
