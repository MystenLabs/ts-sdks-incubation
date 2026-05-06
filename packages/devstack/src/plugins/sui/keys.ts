// Sui localnet faucet helper. Per-account key management lives in
// `helpers/keystore.ts`; the `walletServer()` plugin reads the same
// `<stackDir>/.keys/*.key` files when it signs on the frontend's
// behalf.
//
// Funding pipeline per account (accounts.fund action):
//
//   1. ensureFunded: if total balance < minBalance, hit the faucet
//      (which mints a Coin<SUI> object) and wait for it to settle.
//   2. ensureAddressBalance: if the address-balance accumulator
//      (separate from coin objects) holds < minBalance, sign a tx
//      with the account's own keypair to push most of its coin
//      balance into the address-balance via `0x2::coin::send_funds`.
//      Tolerates `AB_TOLERANCE_MIST` of slop so the post-fee AB
//      lands above target — without it, storage fees + AB-gas drift
//      land the AB just below target every cycle and every cycle
//      re-deposits forever.
//
// Why both: coin objects have versions and serialize at the gas-coin
// level (concurrent txs touching the same coin = equivocation).
// Address balances have no version, so a tx with `payment: []`
// pulls gas from the accumulator and never blocks parallel siblings.
// Funding into AB is the prerequisite for AB-gas mode (PR 35).
//
// Read-only probes (`fetchBalance`, `fetchAddressBalance`) are exposed
// so the sui plugin's getStatus can check funding without doing the
// work. The reconciler contract is "getStatus is a read-only probe";
// the plugin's run does the actual deposit.

import { Transaction } from '@mysten/sui/transactions';
import type { Signer } from '@mysten/sui/cryptography';
import { SuiJsonRpcClient } from '@mysten/sui/jsonRpc';

interface FaucetFundOptions {
	faucetUrl: string;
	rpcUrl: string;
	address: string;
	/** MIST. Default 50 SUI. */
	minBalance?: bigint;
	/** Max wait for the faucet coin to settle. Default 5s. */
	settleTimeoutMs?: number;
}

export const DEFAULT_MIN_BALANCE = 50_000_000_000n;

/** Reserve held back as coin objects for any tx still using `tx.gas`
 * directly (tests, sponsor-style flows). Everything above this gets
 * pushed into address balance. 5 SUI keeps a single comfortable gas
 * coin per account. */
export const COIN_RESERVE_MIST = 5_000_000_000n;

/** Tolerance band: AB is considered "at target" when `ab + tolerance ≥ target`.
 * Storage fees + AB-mode gas drift on subsequent cycles routinely shave
 * tens of millions of MIST off the post-deposit AB; without a tolerance
 * band the AB lands just-under target and every cycle re-deposits forever
 * (verified empirically pre-fix: publisher AB grew 44.98 → 999.985 SUI
 * across three sequential applies). 1 SUI is generous — storage fees on
 * a tiny tx are <0.1 SUI in practice. */
export const AB_TOLERANCE_MIST = 1_000_000_000n;

/** Default cap on the deposit tx submission. Two minutes is the
 * supervisor's action timeout; surfacing a clean 30s failure beats a
 * generic 2-min "Internal error". The validator's stuck-tx retry queue
 * (caused by a stale gas-coin reference) is the typical reason this
 * fires. Override per-call via `EnsureAddressBalanceOptions.timeoutMs`
 * for tests or in environments where 30s is too aggressive. */
const DEFAULT_DEPOSIT_TIMEOUT_MS = 30_000;

const SUI_COIN_TYPE = '0x2::sui::SUI';

/** Per-process per-address mutex. `accounts.fund.run` walks all
 * accounts sequentially, but defense in depth: if two cycles ever
 * race on the same address, serializing prevents two concurrent
 * send-funds txs from picking the same gas coin. */
const fundLocks = new Map<string, Promise<void>>();

/** Fund `address` from the localnet faucet if its balance is below `minBalance`. */
export async function ensureFunded(opts: FaucetFundOptions): Promise<{ funded: boolean }> {
	const minBalance = opts.minBalance ?? DEFAULT_MIN_BALANCE;
	const before = await fetchBalance(opts.rpcUrl, opts.address);
	if (before >= minBalance) return { funded: false };
	await requestFromFaucet(opts.faucetUrl, opts.address);
	const settle = opts.settleTimeoutMs ?? 5000;
	const deadline = Date.now() + settle;
	while (Date.now() < deadline) {
		await new Promise((r) => setTimeout(r, 250));
		const after = await fetchBalance(opts.rpcUrl, opts.address);
		if (after >= minBalance) return { funded: true };
	}
	throw new Error(
		`faucet funded ${opts.address} but balance never reached ${minBalance} MIST within ${settle}ms`,
	);
}

interface EnsureAddressBalanceOptions {
	rpcUrl: string;
	signer: Signer;
	/** MIST. Defaults to 50 SUI minus the coin reserve. */
	minAddressBalance?: bigint;
	/** Hard cap on the deposit tx. Default `DEFAULT_DEPOSIT_TIMEOUT_MS` (30s). */
	timeoutMs?: number;
}

/** Push the address's free coin balance into its SUI address-balance
 * accumulator until it holds at least `minAddressBalance`. Idempotent:
 * skips when the AB is already sufficient. Signs with the account's
 * own keypair using a coin-mode gas tx — the address must already
 * have a regular SUI coin (call `ensureFunded` first). Submission is
 * capped at `DEPOSIT_TIMEOUT_MS`; a stuck-tx retry queue surfaces as
 * a clean actionable error rather than a 2-minute hang. */
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
		const ab = await fetchAddressBalance(opts.rpcUrl, address);
		// Tolerance band: post-fee AB lands a few MIST under target;
		// without this skip, every cycle re-deposits forever.
		if (ab + AB_TOLERANCE_MIST >= target) return { funded: false };

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

		const timeoutMs = opts.timeoutMs ?? DEFAULT_DEPOSIT_TIMEOUT_MS;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const timeoutPromise = new Promise<never>((_, reject) => {
			timer = setTimeout(
				() =>
					reject(
						new Error(
							`ensureAddressBalance: deposit tx for ${address} timed out after ${timeoutMs}ms — the chain may have a stale gas-coin retry queue. Try \`devstack reset --yes\` to wipe the stack.`,
						),
					),
				timeoutMs,
			);
		});
		// Pre-attach a no-op rejection handler to the timeout-promise so
		// that even if the SDK call wins the race, the timer's eventual
		// (now-irrelevant) rejection isn't flagged unhandled. The race
		// itself reads the rejection through its own attached handler;
		// this catch is purely for the post-settle case.
		timeoutPromise.catch(() => undefined);
		const result = await Promise.race([
			client.signAndExecuteTransaction({
				signer: opts.signer,
				transaction: tx,
				options: { showEffects: true },
			}),
			timeoutPromise,
		]).catch((err) => {
			if (err instanceof Error && err.message.startsWith('ensureAddressBalance:')) throw err;
			throw new Error(
				`ensureAddressBalance: deposit tx for ${address} failed: ${err instanceof Error ? err.message : String(err)}`,
			);
		}).finally(() => {
			if (timer !== undefined) clearTimeout(timer);
		});

		if (result.effects?.status?.status !== 'success') {
			throw new Error(
				`ensureAddressBalance: deposit tx for ${address} failed: ${result.effects?.status?.error ?? 'unknown'}`,
			);
		}
		await client.waitForTransaction({ digest: result.digest });
		return { funded: true };
	} finally {
		release();
		fundLocks.delete(address);
	}
}

/** Read the address-balance accumulator (separate from coin objects).
 * Returns 0n when the chain doesn't surface the field (older RPCs).
 * Used by the sui plugin's getStatus probe to verify funding without
 * doing chain mutation. */
export async function fetchAddressBalance(rpcUrl: string, address: string): Promise<bigint> {
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
	if (!res.ok) throw new Error(`fetchAddressBalance: HTTP ${res.status}`);
	const body = (await res.json()) as {
		result?: { fundsInAddressBalance?: string; addressBalance?: string };
	};
	const ab = body.result?.fundsInAddressBalance ?? body.result?.addressBalance;
	return BigInt(ab ?? '0');
}

/** Read the address's total SUI balance (coin objects + accumulator).
 * The faucet seeds this; the AB-deposit converts most of it into the
 * accumulator. */
export async function fetchBalance(rpcUrl: string, address: string): Promise<bigint> {
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
	if (!res.ok) throw new Error(`fetchBalance: HTTP ${res.status}`);
	const body = (await res.json()) as { result?: { totalBalance?: string } };
	return BigInt(body.result?.totalBalance ?? '0');
}

/** Faucet `/v2/gas` POST with exponential-backoff + jitter retry on
 * 5xx responses. The cold-genesis race between "faucet HTTP up" and
 * "validator ready to execute coin txns" routinely produces 5–10 s of
 * 500s with `Failed to execute transaction after N retries`; bare
 * `fetch` without retry surfaced that as `accounts.fund` failures during
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
