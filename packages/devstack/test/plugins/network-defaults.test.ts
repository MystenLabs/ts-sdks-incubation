import { describe, expect, it } from '@effect/vitest';

import { DevstackNetworkParseError } from '../../src/api/inference-network.ts';
import { seal } from '../../src/plugins/seal/index.ts';
import { sui } from '../../src/plugins/sui/index.ts';
import { walrus } from '../../src/plugins/walrus/index.ts';

const withNetwork = (value: string | undefined, run: () => void): void => {
	const prior = process.env.DEVSTACK_NETWORK;
	if (value === undefined) delete process.env.DEVSTACK_NETWORK;
	else process.env.DEVSTACK_NETWORK = value;
	try {
		run();
	} finally {
		if (prior === undefined) delete process.env.DEVSTACK_NETWORK;
		else process.env.DEVSTACK_NETWORK = prior;
	}
};

describe('plugin DEVSTACK_NETWORK defaults', () => {
	it('sui and walrus reject unknown DEVSTACK_NETWORK instead of falling back to local', () => {
		withNetwork('bogus-network', () => {
			expect(() => sui()).toThrow(DevstackNetworkParseError);
			expect(() => walrus()).toThrow(DevstackNetworkParseError);
		});
	});

	it('seal uses the same unknown-network parser before mode dispatch', () => {
		withNetwork('bogus-network', () => {
			expect(() => seal()).toThrow(DevstackNetworkParseError);
		});
	});
});
