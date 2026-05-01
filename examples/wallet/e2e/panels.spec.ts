import { expect, test } from '@playwright/test';

import { connectAs } from '@mysten-incubation/devstack/playwright';

/**
 * End-to-end smoke for `@mysten-incubation/devstack-wallet-panels`:
 *
 *   1. Connect via dApp Kit (the wallet auto-connects with publisher).
 *   2. Open the dev-wallet drawer → Faucet/Packages/Network tabs render.
 *   3. Click "Mint 1.000000 musdc" → publisher's MUSDC cell in the
 *      Balances table goes from 0 to a non-zero value, proving the
 *      panel's tx routed all the way through the DevstackSignerAdapter
 *      → wallet-server → on-chain.
 */

test('faucet panel mints custom token via wallet-server', async ({ page }) => {
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

	// The Faucet panel signs via the wallet directly (not through
	// `useDevstackSignAndExecute`), so it doesn't invalidate the app's
	// query keys. The wallet example polls balances every 2s, so the cell
	// updates on its own — no reload needed.
	await expect(publisherMusdc).not.toHaveText(before, { timeout: 15_000 });
});

test('packages panel shows captured object ids', async ({ page }) => {
	await connectAs(page, 'publisher');
	await page.locator('dev-wallet-panel').locator('.trigger').click();
	const drawer = page.locator('dev-wallet-panel');
	await drawer.locator('dev-wallet-tab-bar').getByRole('tab', { name: 'Packages' }).click();
	const packages = drawer.locator('devstack-packages-panel');
	// The package row's label is `mock_usdc`; its captured `type` value
	// also contains the substring. Match exact label text to keep the
	// assertion unambiguous. mock_usdc and mock_weth both have a
	// `treasuryCapId` row, so allow ≥1 match.
	await expect(packages.getByText('mock_usdc', { exact: true })).toBeVisible();
	await expect(packages.getByText('treasuryCapId', { exact: true }).first()).toBeVisible();
	await expect(packages.getByText('deepbook', { exact: true })).toBeVisible();
});

test('network panel shows wallet-server entry', async ({ page }) => {
	await connectAs(page, 'publisher');
	await page.locator('dev-wallet-panel').locator('.trigger').click();
	const drawer = page.locator('dev-wallet-panel');
	await drawer.locator('dev-wallet-tab-bar').getByRole('tab', { name: 'Network' }).click();
	const network = drawer.locator('devstack-network-panel');
	await expect(network.getByText('wallet-server')).toBeVisible();
	await expect(network.getByText(/http:\/\/localhost:\d+/)).toBeVisible();
});
