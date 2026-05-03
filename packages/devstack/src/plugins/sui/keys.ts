// Sui localnet faucet helper. Per-account key management lives in
// `helpers/keystore.ts`; the `walletServer()` plugin reads the same
// `<stackDir>/.keys/*.key` files when it signs on the frontend's
// behalf.
//
// Funding pipeline per account (sui.accounts action):
//
//   1. ensureFunded: if total balance < minBalance, hit the faucet
//      (which mints a Coin<SUI> object) and wait for it to settle.
//   2. ensureAddressBalance: if the address-balance accumulator
//      (separate from coin objects) holds < minBalance, sign a tx
//      with the account's own keypair to push most of its coin
//      balance into the address-balance via `0x2::coin::send_funds`.
//      Idempotent; protected by an in-process per-address mutex so
//      concurrent calls don't race on the same coin object.
//
// Why both: coin objects have versions and serialize at the gas-coin
// level (concurrent txs touching the same coin = equivocation).
// Address balances have no version, so a tx with `payment: []`
// pulls gas from the accumulator and never blocks parallel siblings.
// Funding into AB is the prerequisite for AB-gas mode (PR 35).

import { Transaction } from '@mysten/sui/transactions';
import type { Signer } from '@mysten/sui/cryptography';
import { SuiJsonRpcClient } from '@mysten/sui/jsonRpc';

export interface FaucetFundOptions {
	faucetUrl: string;
	rpcUrl: string;
	address: string;
	/** MIST. Default 50 SUI. */
	minBalance?: bigint;
	/** Max wait for the faucet coin to settle. Default 5s. */
	settleTimeoutMs?: number;
}

const DEFAULT_MIN_BALANCE = 50_000_000_000n;

/** Fund `address` from the localnet faucet if its balance is below `minBalance`. */
export async function ensureFunded(opts: FaucetFundOptions): Promise<{ funded: boolean }> {
	const minBalance = opts.minBalance ?? DEFAULT_MIN_BALANCE;
	const before = await getBalance(opts.rpcUrl, opts.address);
	if (before >= minBalance) return { funded: false };
	await requestFromFaucet(opts.faucetUrl, opts.address);
	const settle = opts.settleTimeoutMs ?? 5000;
	const deadline = Date.now() + settle;
	while (Date.now() < deadline) {
		await new Promise((r) => setTimeout(r, 250));
		const after = await getBalance(opts.rpcUrl, opts.address);
		if (after >= minBalance) return { funded: true };
	}
	throw new Error(
		`faucet funded ${opts.address} but balance never reached ${minBalance} MIST within ${settle}ms`,
	);
}

/** Reserve held back as coin objects for any tx still using `tx.gas`
 * directly (tests, sponsor-style flows). Everything above this gets
 * pushed into address balance. 5 SUI keeps a single comfortable gas
 * coin per account. */
const COIN_RESERVE_MIST = 5_000_000_000n;

const SUI_COIN_TYPE = '0x2::sui::SUI';

/** Per-process per-address mutex. `sui.accounts.run` walks all
 * accounts sequentially anyway, but the warm-path getStatus probe
 * runs concurrently with other plugins; serializing by address
 * prevents two concurrent send-funds txs from picking the same gas
 * coin (the very equivocation we're trying to eliminate, while we're
 * still using coin-mode gas to bootstrap). */
const fundLocks = new Map<string, Promise<void>>();

export interface EnsureAddressBalanceOptions {
	rpcUrl: string;
	signer: Signer;
	/** MIST. Defaults to 50 SUI minus the coin reserve. */
	minAddressBalance?: bigint;
}

/** Push the address's free coin balance into its SUI address-balance
 * accumulator until it holds at least `minAddressBalance`. Idempotent:
 * skips when the AB is already sufficient. Signs with the account's
 * own keypair using a coin-mode gas tx — the address must already
 * have a regular SUI coin (call `ensureFunded` first). */
export async function ensureAddressBalance(
	opts: EnsureAddressBalanceOptions,
): Promise<{ funded: boolean }> {
	const address = opts.signer.toSuiAddress();
	const target = opts.minAddressBalance ?? DEFAULT_MIN_BALANCE - COIN_RESERVE_MIST;
	if (target <= 0n) return { funded: false };
	const prior = fundLocks.get(address);
	if (prior !== undefined) await prior;
	let release: () => void = () => {};
	const lock = new Promise<void>((resolve) => {
		release = resolve;
	});
	fundLocks.set(address, lock);
	try {
		const client = new SuiJsonRpcClient({ url: opts.rpcUrl, network: 'localnet' });
		const ab = await getAddressBalance(opts.rpcUrl, address);
		if (ab >= target) return { funded: false };

		const coins = await client.getCoins({ owner: address, coinType: SUI_COIN_TYPE });
		const sorted = [...coins.data].sort((a, b) =>
			BigInt(b.balance) > BigInt(a.balance) ? 1 : -1,
		);
		const gas = sorted[0];
		if (gas === undefined) {
			throw new Error(`ensureAddressBalance: ${address} owns no SUI coins to deposit`);
		}
		const movable = BigInt(gas.balance) - COIN_RESERVE_MIST;
		const deficit = target - ab;
		const send = movable < deficit ? movable : deficit;
		if (send <= 0n) {
			throw new Error(
				`ensureAddressBalance: ${address} largest coin ${gas.balance} below COIN_RESERVE_MIST + minAddressBalance — call ensureFunded first`,
			);
		}

		const tx = new Transaction();
		// Split the send-amount off the gas coin, then deposit the split
		// into the address's accumulator. `tx.gas` here is coin-mode (we
		// haven't enabled AB gas yet — this very tx is what's bootstrap-
		// ing the AB).
		const [chunk] = tx.splitCoins(tx.gas, [tx.pure.u64(send)]);
		if (chunk === undefined) throw new Error('ensureAddressBalance: splitCoins returned no result');
		tx.moveCall({
			target: '0x2::coin::send_funds',
			typeArguments: [SUI_COIN_TYPE],
			arguments: [chunk, tx.pure.address(address)],
		});
		tx.setGasBudget(50_000_000n);
		const result = await client.signAndExecuteTransaction({
			signer: opts.signer,
			transaction: tx,
			options: { showEffects: true },
		});
		if (result.effects?.status?.status !== 'success') {
			throw new Error(
				`ensureAddressBalance: tx failed: ${result.effects?.status?.error ?? 'unknown'}`,
			);
		}
		await client.waitForTransaction({ digest: result.digest });
		return { funded: true };
	} finally {
		release();
		fundLocks.delete(address);
	}
}

async function getAddressBalance(rpcUrl: string, address: string): Promise<bigint> {
	const res = await fetch(rpcUrl, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({
			jsonrpc: '2.0',
			method: 'suix_getBalance',
			params: [address, SUI_COIN_TYPE],
			id: 1,
		}),
	});
	if (!res.ok) throw new Error(`getAddressBalance: HTTP ${res.status}`);
	const body = (await res.json()) as {
		result?: { fundsInAddressBalance?: string; addressBalance?: string };
	};
	const ab = body.result?.fundsInAddressBalance ?? body.result?.addressBalance;
	return BigInt(ab ?? '0');
}

async function getBalance(rpcUrl: string, address: string): Promise<bigint> {
	const res = await fetch(rpcUrl, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({
			jsonrpc: '2.0',
			method: 'suix_getBalance',
			params: [address],
			id: 1,
		}),
	});
	if (!res.ok) throw new Error(`getBalance: HTTP ${res.status}`);
	const body = (await res.json()) as { result?: { totalBalance?: string } };
	return BigInt(body.result?.totalBalance ?? '0');
}

/** Faucet `/v2/gas` POST with exponential-backoff + jitter retry on
 * 5xx responses. The cold-genesis race between "faucet HTTP up" and
 * "validator ready to execute coin txns" routinely produces 5–10 s of
 * 500s with `Failed to execute transaction after N retries`; bare
 * `fetch` without retry surfaced that as `sui.accounts` failures during
 * cold first-apply on every test stack. CLAUDE.md anti-pattern:
 * "long-running processes that process.exit(1) on transient errors
 * with no restart" — this is the same shape, just shorter-lived.
 *
 * 4xx responses (auth/malformed-request) are NOT retried — those are
 * permanent. Network errors (connection reset / refused) ARE retried
 * because they look the same as a backend that's mid-restart. */
async function requestFromFaucet(faucetUrl: string, address: string): Promise<void> {
	const maxAttempts = 6;
	let lastErr: Error = new Error(`faucet ${faucetUrl}/v2/gas: never attempted`);
	for (let attempt = 0; attempt < maxAttempts; attempt++) {
		try {
			const res = await fetch(`${faucetUrl}/v2/gas`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ FixedAmountRequest: { recipient: address } }),
			});
			if (res.ok) return;
			const body = await res.text();
			lastErr = new Error(`faucet ${faucetUrl}/v2/gas → ${res.status}: ${body}`);
			if (res.status < 500) {
				// 4xx — caller bug, no retry.
				throw lastErr;
			}
			// 5xx — fall through to backoff + retry.
		} catch (err) {
			if (lastErr === err) throw err; // 4xx rethrow above
			lastErr = err as Error;
			// fetch() throws on network errors / connection refused — retry.
		}
		if (attempt < maxAttempts - 1) {
			// 250ms · 2^attempt + 0–100ms jitter — caps the worst case at
			// ~16 s (250+500+1000+2000+4000+jitter) which covers the
			// observed cold-genesis settle time.
			const baseMs = 250 * 2 ** attempt;
			const jitter = Math.floor(Math.random() * 100);
			await new Promise((r) => setTimeout(r, baseMs + jitter));
		}
	}
	throw lastErr;
}
