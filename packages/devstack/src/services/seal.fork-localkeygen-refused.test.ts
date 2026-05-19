// Phase 3 P3.T6 — explicit `sealLocalKeygen()` on a fork stack must
// trip `ForkIncompatibleError` at factory time with an actionable
// hint pointing at the known-key-server alternative. Pure-unit test
// (no Docker, no supervisor).
//
// The fork incompatibility is structural: the seal key-server binary's
// `SuiRpcClient` (see `crates/key-server/src/sui_rpc_client.rs`) carries
// BOTH a `sui_sdk::SuiClient` (JSON-RPC) and a `sui_rpc::client::Client`
// (gRPC); `check_policy.dry_run_transaction_block` is JSON-RPC-bound and
// the fork's own `simulate_transaction` returns "unsupported" (R3 of
// `notes/sui-fork-integration.md`). Full audit:
// `notes/sui-fork-phase-5-walrus-seal-audit.md` §2.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sealLocalKeygen } from './seal/internal.js';
import { ForkIncompatibleError } from '../engine/errors.js';
import { tag } from '../advanced/tag.js';
import { Effect } from 'effect';
import type { Account } from '../engine/shared.js';

// Stub signer Ref — the fork-incompat gate runs BEFORE we yield the
// signer at acquire time, so the signer's runtime correctness doesn't
// matter for this test. The factory still requires an `options.signer`
// field (TypeScript), so we pass a no-op tag.
const stubSigner = tag(
	'account/stub' as const,
	Effect.succeed({
		name: 'stub',
		address: '0x0000000000000000000000000000000000000000000000000000000000000001',
	} as Account),
	{
		kind: 'package',
		displayTitle: 'stub',
		display: () => ({ title: 'stub', primary: '0x...' }),
	},
);

describe('Phase 3 P3.T6 — sealLocalKeygen refused under fork mode', () => {
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
		expect(() => sealLocalKeygen({ signer: stubSigner })).toThrow(ForkIncompatibleError);

		try {
			sealLocalKeygen({ signer: stubSigner });
			expect.fail('expected ForkIncompatibleError');
		} catch (err) {
			expect(err).toBeInstanceOf(ForkIncompatibleError);
			const e = err as ForkIncompatibleError;
			expect(e.variant).toBe('sealLocalKeygen');
			expect(e.network).toBe('mainnet-fork');
			expect(e.message).toMatch(/JSON-RPC/);
			expect(e.hint).toMatch(/Seal\(\) or sealKnownKeyServer/);
			expect(e.hint).toMatch(/'mainnet'/);
		}
	});

	it('throws ForkIncompatibleError on testnet-fork with the testnet recipe', () => {
		process.env.DEVSTACK_NETWORK = 'testnet-fork';
		try {
			sealLocalKeygen({ signer: stubSigner });
			expect.fail('expected ForkIncompatibleError');
		} catch (err) {
			const e = err as ForkIncompatibleError;
			expect(e.variant).toBe('sealLocalKeygen');
			expect(e.network).toBe('testnet-fork');
			expect(e.hint).toMatch(/'testnet'/);
		}
	});

	it('throws ForkIncompatibleError on devnet-fork', () => {
		process.env.DEVSTACK_NETWORK = 'devnet-fork';
		expect(() => sealLocalKeygen({ signer: stubSigner })).toThrow(ForkIncompatibleError);
	});

	it('does NOT throw ForkIncompatibleError on localnet', () => {
		process.env.DEVSTACK_NETWORK = 'localnet';
		try {
			sealLocalKeygen({ signer: stubSigner });
		} catch (err) {
			// May throw something else (e.g. image-resolution issues outside
			// a docker context) but it must NOT be the fork-incompat refusal.
			expect(err).not.toBeInstanceOf(ForkIncompatibleError);
		}
	});
});
