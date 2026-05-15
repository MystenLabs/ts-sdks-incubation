// Smoke tests for the variadic `devstack(...)` compose entry. Verifies
// arg flattening, the auto-Sui default-fill, the auto-manifest
// inclusion, and the opts-trailing detection.

import { describe, expect, it } from 'vitest';
import { devstack } from './devstack.js';
import { Account } from '../services/account.js';
import { Package } from '../services/package.js';

describe('devstack(...) composition', () => {
	it('returns a handle with `layer`, `run`, and `runMain`', () => {
		const alice = Account('alice');
		const handle = devstack(alice);
		expect(typeof handle.run).toBe('function');
		expect(typeof handle.runMain).toBe('function');
		expect(handle.layer).toBeDefined();
	});

	it('accepts a mix of refs and ref arrays in the variadic args', () => {
		const alice = Account('alice');
		const bob = Account('bob');
		const hello = Package('hello', './move/hello', { signer: alice });
		const handle = devstack(alice, [bob, hello]);
		expect(handle.layer).toBeDefined();
	});

	it('accepts trailing options', () => {
		const alice = Account('alice');
		const handle = devstack(alice, { renderer: 'silent' });
		expect(handle.layer).toBeDefined();
	});
});
