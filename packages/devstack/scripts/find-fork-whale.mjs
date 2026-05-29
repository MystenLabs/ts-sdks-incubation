#!/usr/bin/env node
// Find / validate a fork-faucet "whale" — an address holding a large
// single SUI coin on a live upstream network. The fork faucet
// (`sui({ mode: 'fork', faucet: { whale } })`) impersonates this address
// to dispense SUI, so it needs ONE coin large enough to cover funding
// requests + the impersonation gas budget.
//
// This is a DISCOVERY/VALIDATION aid, not part of the runtime. Run it in
// a trusted terminal against candidate addresses you sourced yourself
// (e.g. from a block explorer's rich list, the network faucet's sponsor
// address, or an early-checkpoint treasury). It ranks them by largest
// single SUI coin so you can pick a stable whale to put in
// `FORK_DEFAULT_WHALE` (src/plugins/sui/mode/fork.ts) or `faucet.whale`.
//
// Usage:
//   node scripts/find-fork-whale.mjs <testnet|mainnet|devnet> <0xaddr> [0xaddr...]
//
// Example:
//   node scripts/find-fork-whale.mjs testnet 0xabc... 0xdef...
//
// Output: per-address total SUI balance, coin count, and largest single
// coin (the one impersonation actually uses), sorted by largest coin.

const FULLNODE = {
	mainnet: 'https://fullnode.mainnet.sui.io:443',
	testnet: 'https://fullnode.testnet.sui.io:443',
	devnet: 'https://fullnode.devnet.sui.io:443',
};

const SUI = '0x2::sui::SUI';
const MIST_PER_SUI = 1_000_000_000n;

const fmtSui = (mist) => `${(Number(mist) / Number(MIST_PER_SUI)).toLocaleString()} SUI`;

const rpc = async (url, method, params) => {
	const res = await fetch(url, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
	});
	if (!res.ok) {
		throw new Error(`${method} -> HTTP ${res.status}`);
	}
	const json = await res.json();
	if (json.error) {
		throw new Error(`${method} -> ${JSON.stringify(json.error)}`);
	}
	return json.result;
};

// Page through suix_getCoins for the owner's SUI coins.
const allSuiCoins = async (url, owner) => {
	const coins = [];
	let cursor = null;
	do {
		const page = await rpc(url, 'suix_getCoins', [owner, SUI, cursor, 200]);
		coins.push(...page.data);
		cursor = page.hasNextPage ? page.nextCursor : null;
	} while (cursor);
	return coins;
};

const main = async () => {
	const [upstream, ...addresses] = process.argv.slice(2);
	const url = FULLNODE[upstream];
	if (url === undefined || addresses.length === 0) {
		console.error(
			'usage: node scripts/find-fork-whale.mjs <testnet|mainnet|devnet> <0xaddr> [0xaddr...]',
		);
		process.exit(2);
	}

	const rows = [];
	for (const owner of addresses) {
		try {
			const coins = await allSuiCoins(url, owner);
			const balances = coins.map((c) => BigInt(c.balance));
			const total = balances.reduce((a, b) => a + b, 0n);
			const largest = balances.reduce((a, b) => (b > a ? b : a), 0n);
			rows.push({ owner, count: coins.length, total, largest });
		} catch (err) {
			rows.push({ owner, error: err instanceof Error ? err.message : String(err) });
		}
	}

	rows.sort((a, b) => (a.largest === undefined ? 1 : b.largest === undefined ? -1 : b.largest > a.largest ? 1 : -1));

	console.log(`\nFork-whale candidates on ${upstream} (${url})\n`);
	for (const r of rows) {
		if (r.error) {
			console.log(`  ${r.owner}\n    ERROR: ${r.error}\n`);
			continue;
		}
		console.log(
			`  ${r.owner}\n` +
				`    coins: ${r.count}  total: ${fmtSui(r.total)}  largest single coin: ${fmtSui(r.largest)} (${r.largest} MIST)\n`,
		);
	}
	console.log(
		'Pick an address with a large, stable LARGEST-single-coin value. That coin\n' +
			'pays gas and sources the split, so it must exceed (per request) + 1 SUI gas budget.\n',
	);
};

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
