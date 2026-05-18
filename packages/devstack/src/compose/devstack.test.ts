// Smoke tests for the variadic `devstack(...)` compose entry. Verifies
// arg flattening, the auto-Sui default-fill, the auto-manifest
// inclusion, and the opts-trailing detection.

import { Effect } from 'effect';
import { describe, expect, it, vi } from 'vitest';
import { devstack } from './devstack.js';
import { Account } from '../services/account.js';
import { Package } from '../services/package.js';
import { Faucet } from '../faucet/factory.js';
import type { FaucetStrategy } from '../faucet/service.js';

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

	it('does NOT auto-append a Faucet when the user supplied one', () => {
		// `composeStackLayer` warns on duplicate keys (later-wins merge
		// would otherwise drop the user's strategies). A user-supplied
		// Faucet must suppress the auto-append so no duplicate warning
		// fires.
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		try {
			const customStrategy: FaucetStrategy = {
				coinType: 'MYCOIN',
				request: () => Effect.void,
			};
			const alice = Account('alice');
			const handle = devstack(Faucet({ strategies: [customStrategy] }), alice);
			expect(handle.layer).toBeDefined();
			expect(warn).not.toHaveBeenCalled();
		} finally {
			warn.mockRestore();
		}
	});

	it('still auto-appends a Faucet when the user did NOT supply one', () => {
		// Sanity check that the dedup gate doesn't over-fire. With no
		// user-supplied Faucet, the auto-Faucet must still land.
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		try {
			const alice = Account('alice');
			const handle = devstack(alice);
			expect(handle.layer).toBeDefined();
			expect(warn).not.toHaveBeenCalled();
		} finally {
			warn.mockRestore();
		}
	});

	it('honors a custom-named user Faucet (Faucet({ name: ... }))', () => {
		// Dedup keys on the `faucet/` prefix so any user Faucet — even
		// one renamed via `name` — suppresses the auto-append.
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		try {
			const alice = Account('alice');
			const handle = devstack(Faucet({ name: 'custom' }), alice);
			expect(handle.layer).toBeDefined();
			expect(warn).not.toHaveBeenCalled();
		} finally {
			warn.mockRestore();
		}
	});
});
