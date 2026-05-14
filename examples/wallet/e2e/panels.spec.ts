import { connectAs, expect, test } from '@mysten-incubation/devstack-effect/playwright';

/**
 * End-to-end smoke for `@mysten-incubation/devstack-wallet-panels`:
 *
 *   1. Connect via dApp Kit (the wallet auto-connects with publisher).
 *   2. Open the dev-wallet drawer → Faucet/Packages/Network tabs render.
 *   3. Click "Mint 1.000000 musdc" → publisher's MUSDC cell in the
 *      Balances table goes from 0 to a non-zero value, proving the
 *      panel's tx routed all the way through the DevstackSignerAdapter
 *      → wallet-app → on-chain.
 */

test('faucet panel mints custom token via wallet-app', async ({ page }) => {
	await connectAs(page, 'publisher');

	const drawerTrigger = page.locator('dev-wallet-panel').locator('.trigger');
	await drawerTrigger.click();

	const drawer = page.locator('dev-wallet-panel');
	for (const tab of ['Faucet', 'Packages', 'Network']) {
		await expect(
			drawer.locator('dev-wallet-tab-bar').getByRole('tab', { name: tab }),
		).toBeVisible();
	}

	const publisherMusdc = page.getByTestId('balance-publisher-musdc');
	const before = (await publisherMusdc.textContent()) ?? '';

	await drawer.locator('dev-wallet-tab-bar').getByRole('tab', { name: 'Faucet' }).click();
	const faucet = drawer.locator('devstack-faucet-panel');
	await faucet.getByRole('button', { name: /Mint .* musdc/i }).click();
	await expect(faucet.locator('.success').getByText(/Minted/i)).toBeVisible({ timeout: 30_000 });

	await expect(publisherMusdc).not.toHaveText(before, { timeout: 15_000 });
});

test('packages panel shows captured object ids', async ({ page }) => {
	await connectAs(page, 'publisher');
	await page.locator('dev-wallet-panel').locator('.trigger').click();
	const drawer = page.locator('dev-wallet-panel');
	await drawer.locator('dev-wallet-tab-bar').getByRole('tab', { name: 'Packages' }).click();
	const packages = drawer.locator('devstack-packages-panel');
	await expect(packages.getByText('mock_usdc', { exact: true })).toBeVisible();
	await expect(packages.getByText('treasuryCapId', { exact: true }).first()).toBeVisible();
});

test('network panel shows wallet-app entry', async ({ page }) => {
	await connectAs(page, 'publisher');
	await page.locator('dev-wallet-panel').locator('.trigger').click();
	const drawer = page.locator('dev-wallet-panel');
	await drawer.locator('dev-wallet-tab-bar').getByRole('tab', { name: 'Network' }).click();
	const network = drawer.locator('devstack-network-panel');
	const walletAppRow = network.locator('.row').filter({ hasText: 'wallet-app' });
	await expect(walletAppRow).toBeVisible();
	// Wallet URL is now traefik-routed: `http://[<stack>.]wallet.<app>.localhost:5180`
	// (was `http://localhost:<random>` before the routing migration).
	await expect(walletAppRow).toContainText(/http:\/\/[\w.-]+\.localhost:\d+/);
});
