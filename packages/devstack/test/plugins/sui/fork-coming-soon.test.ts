import { describe, expect, it } from '@effect/vitest';

import { chainId, type NetworkConfig } from '../../../src/substrate/index.ts';
import { sui, suiFor, SuiForkComingSoonError } from '../../../src/plugins/sui/index.ts';

describe('sui fork mode coming-soon refusal', () => {
	it('throws a clear synchronous error for direct fork config', () => {
		expect(() => sui({ mode: 'fork', upstream: 'mainnet' })).toThrow(SuiForkComingSoonError);
		expect(() => sui({ mode: 'fork', upstream: 'mainnet' })).toThrow(/coming soon/i);
	});

	it('throws the same refusal through the mode-narrowed fork factory', () => {
		const fork: NetworkConfig<'fork'> = {
			mode: 'fork',
			chain: chainId('sui:mainnet-fork'),
		};

		expect(() => suiFor(fork).mainnet()).toThrow(SuiForkComingSoonError);
	});
});
