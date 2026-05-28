import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from '@effect/vitest';

import {
	DevstackNetworkParseError,
	parseDevstackNetwork,
	resolveStackName,
	resolveStateDir,
} from '../../src/api/inference-network.ts';
import { withTempRootSync } from '../helpers/with-temp-root.ts';

describe('api inference/network', () => {
	it('resolves stack name by explicit option, env, package metadata, then main', () =>
		withTempRootSync('devstack-stack-infer', (root) =>
			withTempRootSync('devstack-no-pkg', (noPkg) => {
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
				expect(resolveStackName({ env: { DEVSTACK_STACK: 'from-env' }, cwd: nested })).toBe(
					'from-env',
				);
				expect(resolveStackName({ env: {}, cwd: nested })).toBe('wallet-demo');
				expect(resolveStackName({ env: {}, cwd: noPkg })).toBe('main');
			}),
		));

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

	it('resolves stateDir idempotently for absolute inputs (double-resolution parity)', () => {
		// Parity check between `runStack`-driver and the CLI's
		// `--state-dir` flag: both call `resolveStateDir`, and both
		// surfaces may feed each other's output back in (e.g. a CLI
		// invocation embeds the absolute resolved path into env, then
		// re-invokes via the library boot path). The resolver must be
		// idempotent for absolute paths so the chained call yields the
		// same string. Relative paths intentionally resolve against
		// `cwd` once — a second pass with the SAME `cwd` is a no-op.
		const cwd = '/tmp/some/work/dir';
		const absolute = '/abs/state';

		const fromRunStack = resolveStateDir({ runtimeRoot: absolute, cwd });
		expect(fromRunStack).toBe(absolute);

		const fromCli = resolveStateDir({ stateDir: absolute, cwd });
		expect(fromCli).toBe(absolute);

		// Feed the output back in (the chained surface scenario).
		const chained = resolveStateDir({ runtimeRoot: fromCli, cwd });
		expect(chained).toBe(absolute);

		// Relative input → resolved against cwd; chained pass on the
		// already-absolute result is idempotent.
		const fromRelative = resolveStateDir({ runtimeRoot: 'rel/state', cwd });
		expect(fromRelative).toBe('/tmp/some/work/dir/rel/state');
		expect(resolveStateDir({ runtimeRoot: fromRelative, cwd })).toBe(fromRelative);

		// Precedence: `runtimeRoot` wins over `stateDir` over `env`.
		expect(
			resolveStateDir({
				runtimeRoot: '/win',
				stateDir: '/lose',
				env: '/lose-too',
				cwd,
			}),
		).toBe('/win');
		expect(resolveStateDir({ stateDir: '/win', env: '/lose', cwd })).toBe('/win');
		expect(resolveStateDir({ env: '/win', cwd })).toBe('/win');
		expect(resolveStateDir({ cwd })).toBe('/tmp/some/work/dir/.devstack');
	});
});
