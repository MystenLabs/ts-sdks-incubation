// Phase 3 P3.T4 — explicit `walrusLocalCluster()` on a fork stack must
// trip `ForkIncompatibleError` at factory time with an actionable
// hint pointing at the known-deployment alternative. Pure-unit test
// (no Docker, no supervisor).
//
// The fork incompatibility is structural: the local cluster's storage
// nodes dial the chain via JSON-RPC (upstream walrus's `DualClient` —
// `crates/walrus-sui/src/client/dual_client.rs` — wraps both JSON-RPC
// and gRPC clients but still has ~12 load-bearing JSON-RPC callsites at
// `devnet-v1.48.0`), which sui-fork does not expose (D5 in
// `notes/sui-fork-integration.md`). Full audit:
// `notes/sui-fork-phase-5-walrus-seal-audit.md` §1.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { walrusLocalCluster } from './walrus/local-cluster.js';
import { ForkIncompatibleError } from '../engine/errors.js';

describe('Phase 3 P3.T4 — walrusLocalCluster refused under fork mode', () => {
	let prev: string | undefined;

	beforeEach(() => {
		prev = process.env.DEVSTACK_NETWORK;
	});

	afterEach(() => {
		if (prev === undefined) delete process.env.DEVSTACK_NETWORK;
		else process.env.DEVSTACK_NETWORK = prev;
	});

	it('throws ForkIncompatibleError on mainnet-fork', () => {
		process.env.DEVSTACK_NETWORK = 'mainnet-fork';
		expect(() => walrusLocalCluster()).toThrow(ForkIncompatibleError);

		try {
			walrusLocalCluster();
			expect.fail('expected ForkIncompatibleError');
		} catch (err) {
			expect(err).toBeInstanceOf(ForkIncompatibleError);
			const e = err as ForkIncompatibleError;
			expect(e.variant).toBe('walrusLocalCluster');
			expect(e.network).toBe('mainnet-fork');
			expect(e.message).toMatch(/sui-fork does not expose/);
			expect(e.hint).toMatch(/Walrus\(\) or walrusKnownDeployment/);
			expect(e.hint).toMatch(/'mainnet'/);
		}
	});

	it('throws ForkIncompatibleError on testnet-fork with the testnet recipe', () => {
		process.env.DEVSTACK_NETWORK = 'testnet-fork';
		try {
			walrusLocalCluster();
			expect.fail('expected ForkIncompatibleError');
		} catch (err) {
			const e = err as ForkIncompatibleError;
			expect(e.variant).toBe('walrusLocalCluster');
			expect(e.network).toBe('testnet-fork');
			expect(e.hint).toMatch(/'testnet'/);
		}
	});

	it('throws ForkIncompatibleError on devnet-fork', () => {
		process.env.DEVSTACK_NETWORK = 'devnet-fork';
		expect(() => walrusLocalCluster()).toThrow(ForkIncompatibleError);
	});

	it('does NOT throw on localnet (the variant the local cluster targets)', () => {
		process.env.DEVSTACK_NETWORK = 'localnet';
		// We expect this NOT to throw ForkIncompatibleError. It may throw
		// other errors (missing signer, etc.) — those are validated by
		// the local-cluster's own tests. The contract here is just that
		// the fork-incompat gate doesn't fire on localnet.
		try {
			walrusLocalCluster();
		} catch (err) {
			expect(err).not.toBeInstanceOf(ForkIncompatibleError);
		}
	});
});
