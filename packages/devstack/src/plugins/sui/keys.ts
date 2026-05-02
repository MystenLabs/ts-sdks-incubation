// Sui localnet faucet helper. Per-account key management lives in
// `helpers/keystore.ts`; the `walletServer()` plugin reads the same
// `<stackDir>/.keys/*.key` files when it signs on the frontend's
// behalf.

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
