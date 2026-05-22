import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from '@effect/vitest';

import {
	DevstackNetworkParseError,
	parseDevstackNetwork,
	resolveStackName,
} from '../../src/api/inference-network.ts';

describe('api inference/network', () => {
	it('resolves stack name by explicit option, env, package metadata, then main', () => {
		const root = mkdtempSync(join(tmpdir(), 'devstack-stack-infer-'));
		const nested = join(root, 'apps', 'wallet');
		mkdirSync(nested, { recursive: true });
		writeFileSync(join(root, 'package.json'), JSON.stringify({ name: '@org/wallet-demo' }));

		expect(
			resolveStackName({
				explicit: 'from-option',
				env: { DEVSTACK_STACK: 'from-env' },
				cwd: nested,
			}),
		).toBe('from-option');
		expect(resolveStackName({ env: { DEVSTACK_STACK: 'from-env' }, cwd: nested })).toBe('from-env');
		expect(resolveStackName({ env: {}, cwd: nested })).toBe('wallet-demo');
		expect(
			resolveStackName({ env: {}, cwd: mkdtempSync(join(tmpdir(), 'devstack-no-pkg-')) }),
		).toBe('main');
	});

	it('normalizes known DEVSTACK_NETWORK aliases and rejects unknown values with a typed error', () => {
		expect(parseDevstackNetwork(undefined)).toEqual({ mode: 'local', name: 'localnet' });
		expect(parseDevstackNetwork('sui:testnet')).toEqual({
			mode: 'live',
			name: 'testnet',
			network: 'testnet',
		});
		expect(parseDevstackNetwork('mainnet-fork')).toEqual({
			mode: 'fork',
			name: 'mainnet-fork',
			upstream: 'mainnet',
		});
		expect(parseDevstackNetwork('sui:testnet-fork', '--network')).toEqual({
			mode: 'fork',
			name: 'testnet-fork',
			upstream: 'testnet',
		});

		expect(() => parseDevstackNetwork('bogus')).toThrow(DevstackNetworkParseError);
		try {
			parseDevstackNetwork('bogus', 'DEVSTACK_NETWORK');
			expect.fail('should have thrown');
		} catch (err) {
			expect(err).toBeInstanceOf(DevstackNetworkParseError);
			expect((err as DevstackNetworkParseError)._tag).toBe('DevstackNetworkParseError');
			expect((err as DevstackNetworkParseError).value).toBe('bogus');
		}
	});
});
