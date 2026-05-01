import { expect, test } from '@playwright/test';

import { connectAs, selectAccount } from '@mysten-incubation/devstack/playwright';

/**
 * Bob swaps 1 SUI for mUSDC against alice's resting bids on the SUI/mUSDC
 * pool. Real Sui localnet, real DeepBook v3 published via devstack, real wallet
 * adapter. The pool is whitelisted (no DEEP fees). seed-orders.ts pre-fills
 * the book with 3 asks + 3 bids per pool.
 */

test.describe.configure({ mode: 'serial' });

test('bob swaps 1 SUI for mUSDC; balances update', async ({ page }) => {
	await connectAs(page, 'bob');

	const bobSui = page.getByTestId('balance-bob-sui');
	const bobUsdc = page.getByTestId('balance-bob-musdc');
	await expect(bobSui).not.toHaveText('…', { timeout: 10_000 });
	await expect(bobUsdc).not.toHaveText('…', { timeout: 10_000 });

	const suiInitial = (await bobSui.textContent()) ?? '';
	const usdcInitial = (await bobUsdc.textContent()) ?? '';

	const swapCard = page.locator('section').filter({ hasText: /^Swap/ });
	await selectAccount(swapCard.getByLabel(/^pool$/i), 'SUI / MUSDC');
	await selectAccount(swapCard.getByLabel(/^direction$/i), 'Sell SUI → MUSDC');
	await swapCard.getByLabel(/^amount in/i).fill('1');
	await swapCard.getByRole('button', { name: /^Swap SUI/ }).click();

	await expect(swapCard.getByText(/Last tx:/i)).toBeVisible({ timeout: 30_000 });

	await expect(bobSui).not.toHaveText(suiInitial, { timeout: 10_000 });
	await expect(bobUsdc).not.toHaveText(usdcInitial, { timeout: 10_000 });
});
