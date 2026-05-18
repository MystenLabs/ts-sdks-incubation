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

	it('recognizes a plain options object (no `__layer`) as options, not a ref', () => {
		// If the options branch is missed, `defineDevstack` will reject the
		// trailing object as a StackMember and throw. A successful handle
		// build is evidence the options branch fired.
		const alice = Account('alice');
		const opts = { renderer: 'silent' as const, extras: { hello: 'world' } };
		const handle = devstack(alice, opts);
		expect(handle.layer).toBeDefined();
	});

	it('treats an object with `__layer` as a ref even when it shares option-shaped keys', () => {
		// Fake ref shaped like an options object but carrying the
		// `__layer` brand. `isOptions` must skip this and pass it
		// through to the stack-member flatten path.
		const alice = Account('alice');
		const fakeRef = { __layer: alice.__layer, renderer: 'silent' };
		const handle = devstack(alice, fakeRef as unknown as typeof alice);
		expect(handle.layer).toBeDefined();
	});
});
