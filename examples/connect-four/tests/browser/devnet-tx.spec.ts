import { expect, test, type Page } from '@playwright/test';
import { connectAs, switchNetwork } from '@mysten-incubation/devstack/playwright';

// Capstone: a REAL devnet transaction, SIGNED BY THE DEV WALLET, driven in a
// browser, AFTER a localnet→devnet UI switch.
//
// `network-switch.spec.ts` proves the SWITCH (dApp Kit repoints, the wallet
// stays connected) with NO devnet tx. This spec closes the final gap: after
// the switch it performs a real on-chain `create_lobby` against the committed
// devnet `connect_four` package and asserts the tx LANDED ON DEVNET.
//
// The dev wallet's `alice` is an EPHEMERAL per-boot keypair with no devnet gas,
// so the spec FUNDS her on devnet (the public devnet faucet) before signing,
// and waits (bounded) for the coin to land. Identity is network-agnostic — the
// SAME address signs on localnet and devnet — so funding the address read off
// the connected wallet is sufficient.

const DEVNET_RPC = 'https://fullnode.devnet.sui.io:443';
const DEVNET_FAUCET = 'https://faucet.devnet.sui.io/v2/gas';

const networkIndicator = (page: Page) => page.getByTestId('current-network');
// The app surfaces the executed tx digest as `tx <digest>` in the chain card.
const digestLine = (page: Page) => page.locator('p.digest');

// Read the FULL address of a dev-wallet account (by its devstack `label`) off
// the wallet-standard wallet the dev-wallet injects on the page. The app's
// `.account-line code` only renders the SHORTENED address; this is the full
// one, which we need to fund + assert as the devnet sender. Identity is
// network-agnostic, so this is the same address that signs on devnet.
const devWalletAddress = (page: Page, accountName: string): Promise<string> =>
	page.evaluate(async (name) => {
		const slot = (
			globalThis as {
				__devstackDevWallet__?: {
					wallet?: { accounts?: ReadonlyArray<{ address: string; label?: string }> };
				};
			}
		).__devstackDevWallet__;
		const account = slot?.wallet?.accounts?.find((a) => a.label === name);
		if (account === undefined) {
			throw new Error(`no dev-wallet account labelled "${name}" registered on the page`);
		}
		return account.address;
	}, accountName);

// Minimal JSON-RPC POST helper against a Sui fullnode.
async function rpc<T>(method: string, params: unknown[]): Promise<T> {
	const res = await fetch(DEVNET_RPC, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
	});
	if (!res.ok) throw new Error(`${method} HTTP ${res.status}`);
	const body = (await res.json()) as { result?: T; error?: { message?: string } };
	if (body.error) throw new Error(`${method} RPC error: ${body.error.message ?? 'unknown'}`);
	return body.result as T;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Hit the devnet HTTP faucet for `recipient`, retrying on rate-limit (429).
// Returns once the faucet acknowledges (it sends the coin async; balance is
// then polled separately).
async function fundOnDevnet(recipient: string): Promise<void> {
	const maxAttempts = 6;
	for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
		const res = await fetch(DEVNET_FAUCET, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ FixedAmountRequest: { recipient } }),
		});
		if (res.ok) return;
		// 429 (rate-limited) or transient 5xx — back off and retry.
		if (res.status === 429 || res.status >= 500) {
			const backoffMs = 3_000 * attempt;
			await sleep(backoffMs);
			continue;
		}
		const text = await res.text().catch(() => '');
		throw new Error(`devnet faucet failed: HTTP ${res.status} ${text}`);
	}
	throw new Error(`devnet faucet still rate-limited after ${maxAttempts} attempts`);
}

// Poll devnet `suix_getBalance` until `address` has SUI, or time out.
async function waitForDevnetGas(address: string, timeoutMs: number): Promise<bigint> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const balance = await rpc<{ totalBalance: string }>('suix_getBalance', [
			address,
			'0x2::sui::SUI',
		]);
		const total = BigInt(balance.totalBalance);
		if (total > 0n) return total;
		if (Date.now() >= deadline) {
			throw new Error(`alice still has no devnet gas after ${timeoutMs}ms (address ${address})`);
		}
		await sleep(3_000);
	}
}

test('funds alice on devnet, then signs a real on-chain create_lobby in the browser after the switch', async ({
	page,
}) => {
	// Funding (faucet ack + bounded balance poll) plus a real devnet tx
	// round-trip needs more headroom than the default per-test timeout.
	test.setTimeout(240_000);

	// ── 1. Load app, connect alice on localnet, read her address ─────────────
	await page.goto('/');
	await expect(page.getByRole('heading', { name: 'Connect Four' })).toBeVisible();

	await connectAs(page, 'alice');
	await expect(networkIndicator(page)).toHaveAttribute('data-network', 'localnet');

	// alice's address is network-agnostic — the SAME address signs on localnet
	// and devnet — so this is the address to fund + assert as the devnet sender.
	const aliceAddress = await devWalletAddress(page, 'alice');
	expect(aliceAddress).toMatch(/^0x[0-9a-fA-F]{64}$/);

	// ── 2. Fund alice on devnet + wait for the coin to land ──────────────────
	await fundOnDevnet(aliceAddress);
	// Faucet delivery is async (~30-60s under load); poll with a generous bound.
	const gas = await waitForDevnetGas(aliceAddress, 120_000);
	expect(gas).toBeGreaterThan(0n);

	// ── 3. SWITCH to the committed devnet ────────────────────────────────────
	await switchNetwork(page, 'devnet');
	await expect(networkIndicator(page)).toHaveAttribute('data-network', 'devnet');

	// ── 4. Trigger a real on-chain action (create_lobby) on devnet ───────────
	// This is the SAME app flow as game-flow.spec.ts, but now the active client
	// is the devnet client and `@local/connect-four` resolves (via
	// `forNetwork('devnet').mvrOverrides`) to the committed devnet package. The
	// dev wallet signs (DEVSTACK_AUTO_APPROVE=1 auto-approves) and executes
	// against devnet.
	await page.getByRole('button', { name: 'Create Lobby' }).click({ timeout: 30_000 });

	// The app shows "You are Player A …" once the lobby tx lands, and surfaces
	// the digest in the chain card.
	await expect(page.locator('p.status')).toContainText('You are Player A', { timeout: 60_000 });
	await expect(digestLine(page)).toBeVisible({ timeout: 60_000 });

	const digestText = await digestLine(page).innerText();
	const digest = digestText.replace(/^tx\s+/, '').trim();
	expect(digest.length).toBeGreaterThan(0);

	// ── 5. Assert the tx LANDED ON DEVNET, signed by alice ───────────────────
	// Read the transaction block straight off the devnet fullnode — the proof
	// that this exact digest exists on devnet and was sent by the dev wallet.
	const txBlock = await rpc<{
		digest: string;
		transaction?: { data?: { sender?: string } };
		effects?: { status?: { status?: string }; created?: unknown[] };
	}>('sui_getTransactionBlock', [
		digest,
		{ showInput: true, showEffects: true },
	]);

	expect(txBlock.digest).toBe(digest);
	// Sender is alice — the dev-wallet account that signed in the browser.
	expect(txBlock.transaction?.data?.sender?.toLowerCase()).toBe(aliceAddress.toLowerCase());
	// On-chain effect: success, and a Lobby object was created.
	expect(txBlock.effects?.status?.status).toBe('success');
	expect((txBlock.effects?.created ?? []).length).toBeGreaterThan(0);

	// Surface the digest in the report log so it's verifiable on an explorer.
	console.log(`[devnet-tx] alice=${aliceAddress} digest=${digest}`);
});
