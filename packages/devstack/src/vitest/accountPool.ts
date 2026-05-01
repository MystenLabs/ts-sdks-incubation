// AccountPool — hands out deterministic pre-funded keypairs to tests one at a
// time. `lease()` blocks on exhaustion via an internal waiter queue rather
// than throwing — surfaces flakiness as a clear stall over a confusing
// "AccountPool exhausted" error, and lets parallel tests pile up without
// crashing the whole suite.

import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';

/** Public, deterministic mnemonic. Derived keypairs are reproducible across
 * machines by design — DO NOT use these for anything that holds value on a
 * real network. */
export const DEFAULT_MNEMONIC =
	'success myself pattern sail river shadow inside blade tunnel wool patient orchard';

/** Default pool size; sized for parallel-test workloads where each spec
 * leases 1–2 accounts. Override via `AccountPoolOptions.size`. */
export const DEFAULT_POOL_SIZE = 10;

/** Default min balance per leased account in MIST (5 SUI). Tests that need
 * more should bump `fundEach`. */
export const DEFAULT_FUND_EACH: bigint = 5_000_000_000n;

export interface SeedAccount {
	index: number;
	keypair: Ed25519Keypair;
	address: string;
}

export interface Lease {
	account: SeedAccount;
	/** Returns the account to the pool. Idempotent. */
	release: () => void;
}

export interface AccountPoolOptions {
	/** Sui localnet faucet URL, e.g. the `sui-faucet` service in the manifest. */
	faucetUrl: string;
	/** Sui JSON-RPC URL — used to skip funding when the address already meets
	 * `fundEach`. */
	rpcUrl: string;
	size?: number;
	/** BIP-39 mnemonic. Defaults to `DEFAULT_MNEMONIC` (public). */
	mnemonic?: string;
	/** Min balance per account, in MIST. The faucet is called once per
	 * account up to this amount. */
	fundEach?: bigint;
	/** Pre-fund every account during `seed()`. Default true. Set false in
	 * tests that lease + fund on demand. */
	prefund?: boolean;
}

/**
 * Hands out pre-funded keypairs one at a time. `lease()` blocks when the
 * pool is empty until another caller `release()`s. Use in Vitest's
 * `globalSetup` (one pool per session) plus `await pool.lease()` per test.
 */
export class AccountPool {
	private readonly available: SeedAccount[] = [];
	private readonly waiters: Array<(account: SeedAccount) => void> = [];
	private readonly seedOnce: Promise<void>;

	constructor(private readonly opts: AccountPoolOptions) {
		this.seedOnce = this.doSeed();
	}

	/** Wait until the pool has been seeded (accounts derived + optionally
	 * pre-funded). Idempotent and concurrency-safe — multiple waiters share
	 * a single seed pass. */
	seed(): Promise<void> {
		return this.seedOnce;
	}

	private async doSeed(): Promise<void> {
		const accounts = deriveAccounts(
			this.opts.mnemonic ?? DEFAULT_MNEMONIC,
			this.opts.size ?? DEFAULT_POOL_SIZE,
		);
		this.available.push(...accounts);
		if (this.opts.prefund === false) return;
		const fundEach = this.opts.fundEach ?? DEFAULT_FUND_EACH;
		await Promise.all(
			accounts.map((a) =>
				ensureFunded({
					rpcUrl: this.opts.rpcUrl,
					faucetUrl: this.opts.faucetUrl,
					address: a.address,
					minBalance: fundEach,
				}).catch((err) => {
					throw new Error(`AccountPool: failed to fund ${a.address}`, { cause: err });
				}),
			),
		);
	}

	/** Lease an account. Blocks until one is available. */
	async lease(): Promise<Lease> {
		await this.seedOnce;
		const account = this.available.shift() ?? (await this.waitForRelease());
		let released = false;
		return {
			account,
			release: () => {
				if (released) return;
				released = true;
				const waiter = this.waiters.shift();
				if (waiter) waiter(account);
				else this.available.push(account);
			},
		};
	}

	/** Synchronous accessor for the Nth account. Useful for tests that need
	 * a stable address (e.g. publishing as account 0) without leasing. The
	 * caller is responsible for not leasing the same index in parallel. */
	keypair(index: number): Ed25519Keypair {
		const size = this.opts.size ?? DEFAULT_POOL_SIZE;
		if (index < 0 || index >= size) {
			throw new Error(`AccountPool.keypair: index ${index} out of range [0, ${size}).`);
		}
		return deriveAccount(this.opts.mnemonic ?? DEFAULT_MNEMONIC, index).keypair;
	}

	private waitForRelease(): Promise<SeedAccount> {
		return new Promise<SeedAccount>((resolve) => this.waiters.push(resolve));
	}
}

function deriveAccount(mnemonic: string, index: number): SeedAccount {
	const path = `m/44'/784'/${index}'/0'/0'`;
	const keypair = Ed25519Keypair.deriveKeypair(mnemonic, path);
	return { index, keypair, address: keypair.toSuiAddress() };
}

function deriveAccounts(mnemonic: string, size: number): SeedAccount[] {
	return Array.from({ length: size }, (_, i) => deriveAccount(mnemonic, i));
}

async function ensureFunded(opts: {
	rpcUrl: string;
	faucetUrl: string;
	address: string;
	minBalance: bigint;
}): Promise<void> {
	const balance = await jsonRpcGetBalance(opts.rpcUrl, opts.address);
	if (balance >= opts.minBalance) return;
	await faucetRequest(opts.faucetUrl, opts.address);
	// Give the coin a beat to settle.
	await new Promise((r) => setTimeout(r, 1500));
}

async function jsonRpcGetBalance(rpcUrl: string, address: string): Promise<bigint> {
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
	if (!res.ok) throw new Error(`jsonRpcGetBalance: HTTP ${res.status}`);
	const body = (await res.json()) as { result?: { totalBalance?: string } };
	return BigInt(body.result?.totalBalance ?? '0');
}

async function faucetRequest(faucetUrl: string, address: string): Promise<void> {
	const res = await fetch(`${faucetUrl}/v2/gas`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ FixedAmountRequest: { recipient: address } }),
	});
	if (!res.ok) {
		throw new Error(`Faucet failed for ${address}: ${res.status} ${await res.text()}`);
	}
}
