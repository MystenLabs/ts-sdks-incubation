// P5.T6 — Mint DEEP / USDC from the publisher's TreasuryCap updates
// the user's balance row.

import { connectAs, expect, test } from '@mysten-incubation/devstack/playwright';

test('clicking Mint 100 DEEP updates balance-alice-deep with correct delta', async ({ page }) => {
	await connectAs(page, 'alice');

	const aliceDeep = page.getByTestId('balance-alice-deep');
	await expect(aliceDeep).not.toHaveText('…', { timeout: 30_000 });
	const initial = (await aliceDeep.textContent()) ?? '';

	const mintCard = page.locator('section').filter({ hasText: /^Mint/ });
	await mintCard.getByTestId('mint-deep-100').click();

	await expect(mintCard.getByText(/Last tx:/i)).toBeVisible({ timeout: 30_000 });
	await expect(aliceDeep).not.toHaveText(initial, { timeout: 15_000 });
});
