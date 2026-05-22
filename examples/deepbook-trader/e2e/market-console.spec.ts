import { expect, test, type Locator } from '@playwright/test';
import { connectAs } from '@mysten-incubation/devstack/playwright';

test('renders localnet trader shell and generated coin proof', async ({ page }) => {
	await page.goto('/');

	await expect(page.getByRole('heading', { name: 'DeepBook Trader' })).toBeVisible();
	await expect(page.getByTestId('localnet-mode')).toHaveText('local');
	await expect(page.getByTestId('localnet-rpc')).toContainText('localhost');
	await expect(page.getByTestId('deep-coin-type')).toContainText('::deep::DEEP');
	await expect(page.getByTestId('deepbook-local-status')).toHaveText('unavailable');
	await expect(page.getByRole('heading', { name: 'Trade ticket' })).toBeVisible();
	await expect(page.getByRole('button', { name: /connect/i })).toBeVisible();
});

test('connects the dev wallet account and shows funded local SUI and DEEP', async ({ page }) => {
	await page.goto('/');
	await connectAs(page, 'alice');

	await expect(page.getByTestId('connected-address')).toBeVisible();
	await expect
		.poll(() => readDisplayedBalance(page.getByTestId('sui-balance')), {
			message: 'Alice has local SUI',
		})
		.toBeGreaterThan(0);
	await expect
		.poll(() => readDisplayedBalance(page.getByTestId('deep-balance')), {
			message: 'Alice has at least the configured local DEEP funding',
		})
		.toBeGreaterThanOrEqual(15);
	await expect(page.getByTestId('trade-submit')).toBeVisible();
});

const readDisplayedBalance = async (locator: Locator): Promise<number> => {
	const text = await locator.textContent();
	return Number(text?.replace(/,/g, '') ?? '0');
};
