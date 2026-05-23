import { expect, test, type Locator, type Page } from '@playwright/test';
import { connectAs } from '@mysten-incubation/devstack/playwright';

const BALANCE_TIMEOUT_MS = 30_000;

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
	await expect(page.getByTestId('trade-pay-amount')).toHaveValue('50');
	await expect(page.getByTestId('trade-pay-balance')).toContainText('USDC');
	await expect(page.getByTestId('trade-receive-balance')).toContainText('DBTC');
	await page.getByTestId('trade-direction-toggle').click();
	await expect(page.getByTestId('trade-market')).toHaveValue('DBTC -> USDC');
	await expect(page.getByTestId('trade-pay-amount')).toHaveValue('0.001');
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
			message: 'Trader has local SUI',
			timeout: BALANCE_TIMEOUT_MS,
		})
		.toBeGreaterThan(0);
	await expect
		.poll(() => readDisplayedBalance(page.getByTestId('deep-balance')), {
			message: 'DEEP balance is visible before trading',
			timeout: BALANCE_TIMEOUT_MS,
		})
		.toBeGreaterThanOrEqual(0);
	await expect
		.poll(() => readDisplayedBalance(page.getByTestId('usdc-balance')), {
			message: 'Trader owns local USDC from generic coin funding',
			timeout: BALANCE_TIMEOUT_MS,
		})
		.toBeGreaterThan(0);
	await expect
		.poll(() => readDisplayedBalance(page.getByTestId('dbtc-balance')), {
			message: 'Trader owns local DBTC from generic coin funding',
			timeout: BALANCE_TIMEOUT_MS,
		})
		.toBeGreaterThan(0);
	await expect
		.poll(() => readDisplayedBalance(page.getByTestId('deth-balance')), {
			message: 'Trader owns local DETH from generic coin funding',
			timeout: BALANCE_TIMEOUT_MS,
		})
		.toBeGreaterThan(0);
	await expect(page.getByTestId('trade-pay-balance')).toContainText('SUI');
	await expect(page.getByTestId('trade-submit')).toBeVisible();
});

test('executes local DeepBook swaps in both directions with editable amounts', async ({ page }) => {
	await page.goto('/');
	await connectAs(page, 'trader');

	await expect(page.getByTestId('connected-address')).toBeVisible();
	await expectPositiveBalance(page.getByTestId('sui-balance'), 'Trader SUI');
	const beforeDeep = await readDisplayedBalance(page.getByTestId('deep-balance'));

	await page.getByTestId('trade-pay-amount').fill('0.1');
	await expect(page.getByTestId('trade-submit')).toBeEnabled();
	await page.getByTestId('trade-submit').click();

	await expect(page.getByTestId('trade-digest')).toBeVisible({ timeout: 60_000 });
	await expect(page.getByTestId('trade-digest')).toHaveAttribute('title', /.+/);
	const firstDigest = await page.getByTestId('trade-digest').getAttribute('title');
	await expect(page.getByTestId('trade-error')).toHaveCount(0);
	await expect
		.poll(() => readDisplayedBalance(page.getByTestId('deep-balance')), {
			message: 'DEEP balance remains readable after swap',
			timeout: BALANCE_TIMEOUT_MS,
		})
		.toBeGreaterThanOrEqual(beforeDeep);
	await expect
		.poll(() => readDisplayedBalance(page.getByTestId('deep-balance')), {
			message: 'Trader has enough DEEP for the reverse swap',
			timeout: BALANCE_TIMEOUT_MS,
		})
		.toBeGreaterThanOrEqual(10);

	await page.getByTestId('trade-direction-toggle').click();
	await expect(page.getByTestId('trade-market')).toHaveValue('DEEP -> SUI');
	await page.getByTestId('trade-pay-amount').fill('10');
	await expect(page.getByTestId('trade-submit')).toBeEnabled();
	await page.getByTestId('trade-submit').click();

	await expect
		.poll(
			async () => {
				const digest = await readTradeDigest(page);
				return digest !== firstDigest ? digest : '';
			},
			{
				message: 'second swap produces a new transaction digest',
				timeout: 60_000,
			},
		)
		.toMatch(/.+/);
	await expect(page.getByTestId('trade-error')).toHaveCount(0);
});

const expectPositiveBalance = async (locator: Locator, label: string): Promise<number> => {
	await expect
		.poll(() => readDisplayedBalance(locator), {
			message: `${label} balance is funded`,
			timeout: BALANCE_TIMEOUT_MS,
		})
		.toBeGreaterThan(0);
	return readDisplayedBalance(locator);
};

const readDisplayedBalance = async (locator: Locator): Promise<number> => {
	const text = await locator.textContent();
	return Number(text?.replace(/,/g, '') ?? '0');
};

const readTradeDigest = async (page: Page): Promise<string> => {
	const digest = page.getByTestId('trade-digest');
	if ((await digest.count()) === 0) return '';
	return (await digest.getAttribute('title')) ?? '';
};
