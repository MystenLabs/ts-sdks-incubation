// Tests for the AB-deposit funding pipeline. These pin two real bugs
// found by hands-on review:
//
//  1. unbounded re-deposit on every cycle because storage fees +
//     AB-mode-gas drift land AB just-under target. Fix: tolerance
//     band — `if (ab + AB_TOLERANCE_MIST >= target) skip`.
//  2. opaque 2-minute "Internal error" hang when the validator's
//     stuck-tx retry queue references a stale gas coin. Fix: 30s
//     Promise.race timeout with actionable error message.
//
// We mock @mysten/sui/jsonRpc's SuiJsonRpcClient so the deposit-tx
// path is observable without a live chain, and stub global fetch for
// the suix_getBalance probes.

import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
	AB_TOLERANCE_MIST,
	COIN_RESERVE_MIST,
	DEFAULT_MIN_BALANCE,
	ensureAddressBalance,
	fetchAddressBalance,
	fetchBalance,
} from './keys.js';

// Mock state captured per-test.
const mockClientState: {
	coins: Array<{ coinObjectId: string; balance: string; version: string; digest: string }>;
	signAndExecute: ReturnType<typeof vi.fn>;
	waitForTransaction: ReturnType<typeof vi.fn>;
	getCoins: ReturnType<typeof vi.fn>;
} = {
	coins: [],
	signAndExecute: vi.fn(),
	waitForTransaction: vi.fn(),
	getCoins: vi.fn(),
};

vi.mock('@mysten/sui/jsonRpc', () => ({
	SuiJsonRpcClient: class {
		getCoins = mockClientState.getCoins;
		signAndExecuteTransaction = mockClientState.signAndExecute;
		waitForTransaction = mockClientState.waitForTransaction;
	},
}));

const RPC_URL = 'http://127.0.0.1:9000';

function setBalance(totalBalance: string): void {
	(globalThis as unknown as { fetch: typeof fetch }).fetch = vi.fn(
		async (_url: unknown, init?: { body?: string }) => {
			const body = init?.body !== undefined ? JSON.parse(init.body) : { params: [] };
			const params = body.params as unknown[];
			const isAbProbe = params.length >= 2; // suix_getBalance(addr, coinType)
			return new Response(
				JSON.stringify({
					result: isAbProbe
						? { fundsInAddressBalance: totalBalance, totalBalance: '0' }
						: { totalBalance },
				}),
				{ status: 200, headers: { 'Content-Type': 'application/json' } },
			);
		},
	) as typeof fetch;
}

function setBalances(opts: { totalBalance: string; addressBalance: string }): void {
	(globalThis as unknown as { fetch: typeof fetch }).fetch = vi.fn(
		async (_url: unknown, init?: { body?: string }) => {
			const body = init?.body !== undefined ? JSON.parse(init.body) : { params: [] };
			const params = body.params as unknown[];
			const isAbProbe = params.length >= 2;
			return new Response(
				JSON.stringify({
					result: isAbProbe
						? { fundsInAddressBalance: opts.addressBalance }
						: { totalBalance: opts.totalBalance },
				}),
				{ status: 200, headers: { 'Content-Type': 'application/json' } },
			);
		},
	) as typeof fetch;
}

beforeEach(() => {
	mockClientState.coins = [];
	mockClientState.signAndExecute = vi.fn(async () => ({
		digest: '0xdig',
		effects: { status: { status: 'success' } },
	}));
	mockClientState.waitForTransaction = vi.fn(async () => undefined);
	mockClientState.getCoins = vi.fn(async () => ({ data: mockClientState.coins }));
});

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe('fetchBalance', () => {
	it('reads totalBalance from suix_getBalance', async () => {
		setBalance('123456789');
		expect(await fetchBalance(RPC_URL, '0xabc')).toBe(123_456_789n);
	});

	it('throws on non-200 RPC response', async () => {
		(globalThis as unknown as { fetch: typeof fetch }).fetch = vi.fn(
			async () => new Response('boom', { status: 500 }),
		) as typeof fetch;
		await expect(fetchBalance(RPC_URL, '0xabc')).rejects.toThrow(/HTTP 500/);
	});
});

describe('fetchAddressBalance', () => {
	it('prefers fundsInAddressBalance', async () => {
		setBalances({ totalBalance: '0', addressBalance: '5000' });
		expect(await fetchAddressBalance(RPC_URL, '0xabc')).toBe(5000n);
	});

	it('returns 0n when neither field is present', async () => {
		(globalThis as unknown as { fetch: typeof fetch }).fetch = vi.fn(
			async () => new Response(JSON.stringify({ result: {} }), { status: 200 }),
		) as typeof fetch;
		expect(await fetchAddressBalance(RPC_URL, '0xabc')).toBe(0n);
	});
});

describe('ensureAddressBalance — idempotence (the load-bearing fix)', () => {
	it('returns {funded:false} without signing when AB ≥ target', async () => {
		const target = DEFAULT_MIN_BALANCE - COIN_RESERVE_MIST; // 45 SUI
		setBalances({ totalBalance: '200000000000', addressBalance: target.toString() });
		const signer = Ed25519Keypair.generate();
		const result = await ensureAddressBalance({ rpcUrl: RPC_URL, signer });
		expect(result.funded).toBe(false);
		expect(mockClientState.signAndExecute).not.toHaveBeenCalled();
	});

	it('returns {funded:false} when AB is within tolerance band of target', async () => {
		// Reproduces the 44.98 SUI scenario found by the hands-on agent.
		const target = DEFAULT_MIN_BALANCE - COIN_RESERVE_MIST; // 45 SUI
		const justUnder = target - AB_TOLERANCE_MIST + 1n; // within tolerance
		setBalances({ totalBalance: '200000000000', addressBalance: justUnder.toString() });
		const signer = Ed25519Keypair.generate();
		const result = await ensureAddressBalance({ rpcUrl: RPC_URL, signer });
		expect(result.funded).toBe(false);
		expect(mockClientState.signAndExecute).not.toHaveBeenCalled();
	});

	it('deposits when AB falls below target by more than tolerance', async () => {
		const target = DEFAULT_MIN_BALANCE - COIN_RESERVE_MIST;
		const wellUnder = target - AB_TOLERANCE_MIST - 1n;
		setBalances({ totalBalance: '200000000000', addressBalance: wellUnder.toString() });
		mockClientState.coins = [
			{
				coinObjectId: '0xcoin',
				balance: '200000000000',
				version: '1',
				digest: '0xd1',
			},
		];
		const signer = Ed25519Keypair.generate();
		const result = await ensureAddressBalance({ rpcUrl: RPC_URL, signer });
		expect(result.funded).toBe(true);
		expect(mockClientState.signAndExecute).toHaveBeenCalledOnce();
	});
});

describe('ensureAddressBalance — error surfacing', () => {
	it('wraps SDK throws with address + actionable context', async () => {
		setBalances({ totalBalance: '200000000000', addressBalance: '0' });
		mockClientState.coins = [
			{ coinObjectId: '0xcoin', balance: '200000000000', version: '1', digest: '0xd' },
		];
		mockClientState.signAndExecute = vi.fn(async () => {
			throw new Error('referenced object 0xcoin at version None');
		});
		const signer = Ed25519Keypair.generate();
		await expect(ensureAddressBalance({ rpcUrl: RPC_URL, signer })).rejects.toThrow(
			/ensureAddressBalance: deposit tx for 0x.+ failed: referenced object 0xcoin at version None/,
		);
	});

	it('throws on non-success effects status with the chain error preserved', async () => {
		setBalances({ totalBalance: '200000000000', addressBalance: '0' });
		mockClientState.coins = [
			{ coinObjectId: '0xcoin', balance: '200000000000', version: '1', digest: '0xd' },
		];
		mockClientState.signAndExecute = vi.fn(async () => ({
			digest: '0xdig',
			effects: { status: { status: 'failure', error: 'GasBudgetTooLow' } },
		}));
		const signer = Ed25519Keypair.generate();
		await expect(ensureAddressBalance({ rpcUrl: RPC_URL, signer })).rejects.toThrow(
			/deposit tx for 0x.+ failed: GasBudgetTooLow/,
		);
	});

	it('throws clearly when the address has no SUI coins to deposit from', async () => {
		setBalances({ totalBalance: '0', addressBalance: '0' });
		mockClientState.coins = [];
		const signer = Ed25519Keypair.generate();
		await expect(ensureAddressBalance({ rpcUrl: RPC_URL, signer })).rejects.toThrow(
			/owns no SUI coins to deposit/,
		);
	});

	it('throws when largest coin is below COIN_RESERVE_MIST + minAddressBalance', async () => {
		setBalances({ totalBalance: '0', addressBalance: '0' });
		mockClientState.coins = [
			// 1 SUI coin — well below the 5 SUI reserve
			{ coinObjectId: '0xcoin', balance: '1000000000', version: '1', digest: '0xd' },
		];
		const signer = Ed25519Keypair.generate();
		await expect(ensureAddressBalance({ rpcUrl: RPC_URL, signer })).rejects.toThrow(
			/below COIN_RESERVE_MIST/,
		);
	});
});

describe('ensureAddressBalance — submission timeout', () => {
	it('rejects with actionable msg when the deposit tx hangs past the timeout', async () => {
		setBalances({ totalBalance: '200000000000', addressBalance: '0' });
		mockClientState.coins = [
			{ coinObjectId: '0xcoin', balance: '200000000000', version: '1', digest: '0xd' },
		];
		// Hang the SDK call. Real timers + 50ms timeout — much faster
		// than fake-timer juggling and avoids vitest tracker artifacts.
		let resolveHang: ((value: unknown) => void) | undefined;
		mockClientState.signAndExecute = vi.fn(
			() =>
				new Promise((resolve) => {
					resolveHang = resolve;
				}),
		);

		const signer = Ed25519Keypair.generate();
		await expect(
			ensureAddressBalance({ rpcUrl: RPC_URL, signer, timeoutMs: 50 }),
		).rejects.toThrow(/timed out after 50ms.*devstack wipe --yes/s);
		resolveHang?.({ digest: '0xignored', effects: { status: { status: 'success' } } });
	});
});

describe('ensureAddressBalance — minAddressBalance:0', () => {
	it('returns {funded:false} when target ≤ 0n (caller asked for nothing)', async () => {
		const signer = Ed25519Keypair.generate();
		const result = await ensureAddressBalance({
			rpcUrl: RPC_URL,
			signer,
			minAddressBalance: 0n,
		});
		expect(result.funded).toBe(false);
		expect(mockClientState.signAndExecute).not.toHaveBeenCalled();
	});
});
