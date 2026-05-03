import { expect, test } from '@playwright/test';

import { connectAs, selectAccount } from '@mysten-incubation/devstack/playwright';

/**
 * DeepBook v3 swap exercise: real Sui localnet, real DeepBook v3 published
 * via the `deepbook()` plugin, real wallet adapter. Pools are whitelisted
 * (no DEEP fees) and continuously made by alice via
 * `deepbook.market-maker-alice` (a HostProcess action) — every refresh
 * tick reposts a 3-level grid around the configured mid, so both sides
 * of the book are populated for each test. alice signing both as the
 * maker AND as the user side is parallel-safe because gas is paid from
 * her address-balance accumulator (no shared gas-coin object).
 */

test.describe.configure({ mode: 'serial' });

test('bob swaps 1 SUI for mUSDC against the maker bids; balances update', async ({ page }) => {
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

test('bob swaps 100 mUSDC for SUI against the maker asks; balances update', async ({ page }) => {
	await connectAs(page, 'bob');

	const bobSui = page.getByTestId('balance-bob-sui');
	const bobUsdc = page.getByTestId('balance-bob-musdc');
	await expect(bobSui).not.toHaveText('…', { timeout: 10_000 });
	await expect(bobUsdc).not.toHaveText('…', { timeout: 10_000 });

	const suiInitial = (await bobSui.textContent()) ?? '';
	const usdcInitial = (await bobUsdc.textContent()) ?? '';

	const swapCard = page.locator('section').filter({ hasText: /^Swap/ });
	await selectAccount(swapCard.getByLabel(/^pool$/i), 'SUI / MUSDC');
	await selectAccount(swapCard.getByLabel(/^direction$/i), 'Sell MUSDC → SUI');
	await swapCard.getByLabel(/^amount in/i).fill('100');
	await swapCard.getByRole('button', { name: /^Swap MUSDC/ }).click();

	await expect(swapCard.getByText(/Last tx:/i)).toBeVisible({ timeout: 30_000 });

	await expect(bobSui).not.toHaveText(suiInitial, { timeout: 10_000 });
	await expect(bobUsdc).not.toHaveText(usdcInitial, { timeout: 10_000 });
});
