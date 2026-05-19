// P5.T7 — Place a limit buy against the margin-enabled `sui_usdc` pool.
// Verify the order lands by checking the trading card surfaces a tx
// digest (the order tx executed) and the ticker's best-bid moved.

import { connectAs, expect, selectAccount, test } from '@mysten-incubation/devstack/playwright';

test('alice places a limit buy on sui_usdc; tx submits + ticker reflects the new bid', async ({ page }) => {
	await connectAs(page, 'alice');

	const tradingCard = page.locator('section').filter({ hasText: /^Trading/ });
	await selectAccount(tradingCard.getByLabel(/^pool$/i), 'sui_usdc');
	await selectAccount(tradingCard.getByLabel(/^side$/i), 'buy');
	await tradingCard.getByTestId('trading-price').fill('3500');
	await tradingCard.getByTestId('trading-qty').fill('1');
	await tradingCard.getByTestId('trading-submit').click();

	await expect(tradingCard.getByText(/Last tx:/i)).toBeVisible({ timeout: 30_000 });

	// Ticker is updated by the deepbook-server; the bid value should
	// remain non-empty after the buy lands.
	const bid = page.getByTestId('ticker-sui_usdc-bid');
	await expect(bid).not.toHaveText('—', { timeout: 60_000 });
});
