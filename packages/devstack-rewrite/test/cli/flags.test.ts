import { describe, expect, it } from '@effect/vitest';

import { CliUsageError } from '../../src/surfaces/cli/errors.ts';
import { parseGlobalFlags } from '../../src/surfaces/cli/flags.ts';

describe('cli flags', () => {
	it('normalizes valid network flags through the shared parser', () => {
		const flags = parseGlobalFlags(['--network', 'sui:testnet', 'up'], {
			env: {},
			stdinIsTty: false,
		});
		expect(flags.network).toBe('testnet');
	});

	it('rejects unknown --network values', () => {
		expect(() =>
			parseGlobalFlags(['--network', 'bogus', 'up'], {
				env: {},
				stdinIsTty: false,
			}),
		).toThrow(CliUsageError);
	});

	it('rejects unknown DEVSTACK_NETWORK values', () => {
		expect(() =>
			parseGlobalFlags(['up'], {
				env: { DEVSTACK_NETWORK: 'bogus' },
				stdinIsTty: false,
			}),
		).toThrow(CliUsageError);
	});

	it('lets an explicit --network override an invalid DEVSTACK_NETWORK env value', () => {
		const flags = parseGlobalFlags(['--network', 'devnet', 'up'], {
			env: { DEVSTACK_NETWORK: 'bogus' },
			stdinIsTty: false,
		});
		expect(flags.network).toBe('devnet');
	});
});
