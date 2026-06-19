import { expect, test, type Page } from '@playwright/test';
import { connectAs, switchNetwork } from '@mysten-incubation/devstack/playwright';

// Multi-network capstone: an app shipping TWO networks — the LIVE localnet
// (`e2e` stack, booted by globalSetup) and a COMMITTED devnet
// (`deployments/devnet.ts`) — can flip localnet→devnet through dApp Kit's
// public `switchNetwork`. The PROOF is three-fold and needs NO devnet tx:
//   1. the switch takes effect (dApp Kit's current network = devnet),
//   2. the dev wallet STAYS connected across the switch (the wallet-standard
//      wallet is registered once; only the active network/client changes),
//   3. the app repoints — `useCurrentNetwork()` (the same `$currentNetwork`
//      store `createClient(network)` keys off) now reads devnet, so the client
//      is the devnet client.

// The network indicator the app renders from `useCurrentNetwork()`.
const networkIndicator = (page: Page) => page.getByTestId('current-network');

// Read dApp Kit's current network straight off the test bridge — the same
// `$currentNetwork` store the app's `useCurrentNetwork()` and the
// per-network `createClient` both read.
const bridgeCurrentNetwork = (page: Page): Promise<string | undefined> =>
	page.evaluate(() => {
		const slot = (
			globalThis as {
				__devstackDAppKit__?: { currentNetwork?: () => string };
			}
		).__devstackDAppKit__;
		return slot?.currentNetwork?.();
	});

// The connected signer's address as the app renders it (the `.account-line`
// `<code>` is present only while a wallet is connected — it is replaced by a
// ConnectButton when disconnected). Its visibility + stable value across the
// switch is the wallet-persistence proof.
const connectedAddress = (page: Page) => page.locator('.account-line code');

test('flips localnet→devnet, keeps the dev wallet connected, and repoints the client', async ({
	page,
}) => {
	await page.goto('/');
	await expect(page.getByRole('heading', { name: 'Connect Four' })).toBeVisible();

	// Connect alice on the LIVE localnet (the booted e2e stack's default).
	await connectAs(page, 'alice');
	await expect(networkIndicator(page)).toHaveAttribute('data-network', 'localnet');
	expect(await bridgeCurrentNetwork(page)).toBe('localnet');
	// Connected on localnet: the app renders the connected signer line.
	await expect(connectedAddress(page)).toBeVisible();
	const addressBeforeSwitch = await connectedAddress(page).innerText();
	await expect(networkIndicator(page)).toHaveText('Network: localnet');

	// FLIP to the committed devnet through dApp Kit's public switchNetwork.
	await switchNetwork(page, 'devnet');

	// (1) The switch took effect — dApp Kit's current network is devnet.
	expect(await bridgeCurrentNetwork(page)).toBe('devnet');

	// (3) The app repointed — `useCurrentNetwork()` now reads devnet, so the
	// per-network client `createClient('devnet')` builds (the devnet rpc) is the
	// active client.
	await expect(networkIndicator(page)).toHaveAttribute('data-network', 'devnet');
	await expect(networkIndicator(page)).toHaveText('Network: devnet');

	// (2) The dev wallet STAYS connected across the switch — the app still
	// renders the SAME connected signer (not a ConnectButton). The connection
	// was NOT dropped by the repoint; only the active network/client changed.
	await expect(connectedAddress(page)).toBeVisible();
	expect(await connectedAddress(page).innerText()).toBe(addressBeforeSwitch);
});
