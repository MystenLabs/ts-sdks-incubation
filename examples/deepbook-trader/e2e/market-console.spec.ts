import { expect, test, type Locator } from '@playwright/test';
import { connectAs } from '@mysten-incubation/devstack/playwright';

test('renders localnet trader shell and generated coin proof', async ({ page }) => {
	await page.goto('/');

	await expect(page.getByRole('heading', { name: 'DeepBook Trader' })).toBeVisible();
	await expect(page.getByTestId('localnet-mode')).toHaveText('local');
	await expect(page.getByTestId('localnet-rpc')).toContainText('localhost');
	await expect(page.getByTestId('deepbook-local-status')).toHaveText('configured');
	await expect(page.getByTestId('deepbook-pool')).toHaveText('DEEP_SUI');
	await expect(page.getByTestId('deepbook-pool-count')).toHaveText('4');
	await expect(page.getByTestId('pyth-feed-count')).toHaveText('5 feeds');
	await expect(page.getByTestId('pyth-price-SUI')).toContainText('$3.45');
	await expect(page.getByTestId('pyth-price-USDC')).toContainText('$1.00');
	await expect(page.getByTestId('pyth-price-DBTC')).toContainText('$65,000.00');
	await expect(page.getByTestId('pyth-price-DETH')).toContainText('$3,200.00');
	await expect(page.getByTestId('market-option-SUI_USDC')).toBeVisible();
	await expect(page.getByTestId('market-option-DBTC_USDC')).toBeVisible();
	await expect(page.getByTestId('market-option-DETH_USDC')).toBeVisible();
	await page.getByTestId('market-option-DBTC_USDC').click();
	await expect(page.getByTestId('deepbook-pool')).toHaveText('DBTC_USDC');
	await expect(page.getByTestId('trade-market')).toHaveValue('USDC -> DBTC');
	await expect(page.getByRole('heading', { name: 'Trade ticket' })).toBeVisible();
	await expect(page.getByTestId('trade-submit')).toBeDisabled();
});

test('connects the dev wallet account and shows faucet-funded local demo balances', async ({
	page,
}) => {
	await page.goto('/');
	await connectAs(page, 'trader');

	await expect(page.getByTestId('connected-address')).toBeVisible();
	await expect
		.poll(() => readDisplayedBalance(page.getByTestId('sui-balance')), {
			message: 'Publisher has local SUI',
		})
		.toBeGreaterThan(0);
	await expect
		.poll(() => readDisplayedBalance(page.getByTestId('deep-balance')), {
			message: 'DEEP balance is visible before trading',
		})
		.toBeGreaterThanOrEqual(0);
	await expect
		.poll(() => readDisplayedBalance(page.getByTestId('usdc-balance')), {
			message: 'Trader owns local USDC from generic coin funding',
		})
		.toBeGreaterThan(0);
	await expect
		.poll(() => readDisplayedBalance(page.getByTestId('dbtc-balance')), {
			message: 'Trader owns local DBTC from generic coin funding',
		})
		.toBeGreaterThan(0);
	await expect
		.poll(() => readDisplayedBalance(page.getByTestId('deth-balance')), {
			message: 'Trader owns local DETH from generic coin funding',
		})
		.toBeGreaterThan(0);
	await expect(page.getByTestId('trade-submit')).toBeVisible();
});

test('executes a local DeepBook SUI to DEEP swap', async ({ page }) => {
	await page.goto('/');
	await connectAs(page, 'trader');

	await expect(page.getByTestId('connected-address')).toBeVisible();
	await expectPositiveBalance(page.getByTestId('sui-balance'), 'Trader SUI');
	const beforeDeep = await readDisplayedBalance(page.getByTestId('deep-balance'));

	await expect(page.getByTestId('trade-submit')).toBeEnabled();
	await page.getByTestId('trade-submit').click();

	await expect(page.getByTestId('trade-digest')).toBeVisible({ timeout: 60_000 });
	await expect(page.getByTestId('trade-digest')).toHaveAttribute('title', /.+/);
	await expect(page.getByTestId('trade-error')).toHaveCount(0);
	await expect
		.poll(() => readDisplayedBalance(page.getByTestId('deep-balance')), {
			message: 'DEEP balance remains readable after swap',
		})
		.toBeGreaterThanOrEqual(beforeDeep);
});

const expectPositiveBalance = async (locator: Locator, label: string): Promise<number> => {
	await expect
		.poll(() => readDisplayedBalance(locator), {
			message: `${label} balance is funded`,
		})
		.toBeGreaterThan(0);
	return readDisplayedBalance(locator);
};

const readDisplayedBalance = async (locator: Locator): Promise<number> => {
	const text = await locator.textContent();
	return Number(text?.replace(/,/g, '') ?? '0');
};
