// Sui localnet faucet helper. Per-account key management lives in
// `helpers/keystore.ts` (the dev-wallet's `virtual:devstack-keys` Vite
// plugin reads from the same `<stackDir>/.keys/*.key` files this writes).

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

async function requestFromFaucet(faucetUrl: string, address: string): Promise<void> {
	const res = await fetch(`${faucetUrl}/v2/gas`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ FixedAmountRequest: { recipient: address } }),
	});
	if (!res.ok) {
		throw new Error(`faucet ${faucetUrl}/v2/gas → ${res.status}: ${await res.text()}`);
	}
}
