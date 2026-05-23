import { describe, expect, it } from '@effect/vitest';

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
	it('sui and walrus factories do not read DEVSTACK_NETWORK at import/config time', () => {
		withNetwork('bogus-network', () => {
			expect(() => sui()).not.toThrow();
			expect(() => walrus()).not.toThrow();
		});
	});
});
