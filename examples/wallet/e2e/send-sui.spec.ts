import { expect, test, type Locator } from '@playwright/test';
import { connectAs } from '@mysten-incubation/devstack/playwright';

/**
 * Real Vite dev server, real Sui localnet, real wallet-standard adapter — no mocks.
 * Two cases: native SUI send and a non-SUI mock-USDC send. Both assert balances move.
 */

const SUI_COIN_TYPE = '0x2::sui::SUI';

const selectOptionStartingWith = async (select: Locator, text: string) => {
	const value = await select
		.locator('option')
		.filter({ hasText: new RegExp(`^${text}\\b`) })
		.first()
		.getAttribute('value');
	expect(value, `option starting with "${text}"`).not.toBeNull();
	await select.selectOption(value!);
};

test.describe.configure({ mode: 'serial' });

test('alice sends 0.5 SUI to bob; balances update', async ({ page }) => {
	await page.goto('/');
	await connectAs(page, 'alice');

	const aliceCell = page.getByTestId('balance-alice-sui');
	const bobCell = page.getByTestId('balance-bob-sui');

	await expect(aliceCell).not.toHaveText('…', { timeout: 10_000 });
	await expect(bobCell).not.toHaveText('…', { timeout: 10_000 });

	const aliceInitial = (await aliceCell.textContent()) ?? '';
	const bobInitial = (await bobCell.textContent()) ?? '';

	const sendCard = page.locator('section').filter({ hasText: /^Send/ });
	await sendCard.getByLabel(/^coin$/i).selectOption(SUI_COIN_TYPE);
	await selectOptionStartingWith(sendCard.getByLabel(/recipient/i), 'bob');
	await sendCard.getByLabel(/amount/i).fill('0.5');
	await sendCard.getByRole('button', { name: /^Send$/ }).click();

	await expect(sendCard.getByText(/Last tx:/i)).toBeVisible({ timeout: 30_000 });

	await expect(aliceCell).not.toHaveText(aliceInitial, { timeout: 10_000 });
	await expect(bobCell).not.toHaveText(bobInitial, { timeout: 10_000 });
});

test('alice sends 100 mUSDC to bob; balances update', async ({ page }) => {
	await page.goto('/');
	await connectAs(page, 'alice');

	const aliceCell = page.getByTestId('balance-alice-mock_usdc');
	const bobCell = page.getByTestId('balance-bob-mock_usdc');

	await expect(aliceCell).not.toHaveText('…', { timeout: 10_000 });
	await expect(bobCell).not.toHaveText('…', { timeout: 10_000 });

	const aliceInitial = (await aliceCell.textContent()) ?? '';
	const bobInitial = (await bobCell.textContent()) ?? '';

	const sendCard = page.locator('section').filter({ hasText: /^Send/ });
	await selectOptionStartingWith(sendCard.getByLabel(/^coin$/i), 'mock_usdc');
	await selectOptionStartingWith(sendCard.getByLabel(/recipient/i), 'bob');
	await sendCard.getByLabel(/amount/i).fill('100');
	await sendCard.getByRole('button', { name: /^Send$/ }).click();

	await expect(sendCard.getByText(/Last tx:/i)).toBeVisible({ timeout: 30_000 });
	await expect(aliceCell).not.toHaveText(aliceInitial, { timeout: 10_000 });
	await expect(bobCell).not.toHaveText(bobInitial, { timeout: 10_000 });
});
