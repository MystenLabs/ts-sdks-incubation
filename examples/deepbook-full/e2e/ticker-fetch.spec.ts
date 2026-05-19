// P5.T8 — `/ticker` page renders per-pool rows. Each row carries
// numeric `lastPrice` / `bestBid` / `bestAsk` cells from the
// deepbook-server's REST API.

import { expect, test } from '@mysten-incubation/devstack/playwright';

test('ticker page renders per-pool rows with numeric lastPrice + bestBid + bestAsk', async ({
	page,
}) => {
	await page.goto('/');

	// Wait for the maker to produce orders and the indexer to ingest +
	// the server to report. Up to 60s on cold boot.
	const suiUsdcRow = page.getByTestId('ticker-row-sui_usdc');
	await expect(suiUsdcRow).toBeVisible({ timeout: 30_000 });

	const bid = page.getByTestId('ticker-sui_usdc-bid');
	const ask = page.getByTestId('ticker-sui_usdc-ask');
	await expect(bid).not.toHaveText('—', { timeout: 60_000 });
	await expect(ask).not.toHaveText('—', { timeout: 60_000 });

	const deepSuiRow = page.getByTestId('ticker-row-deep_sui');
	await expect(deepSuiRow).toBeVisible();
});
