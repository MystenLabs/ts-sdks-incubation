import { expect, test } from '@playwright/test';
import { connectAs, selectAccount } from '@mysten-incubation/devstack/playwright';

/**
 * Real Vite dev server, real Sui localnet, real wallet-standard adapter — no mocks.
 * Two cases: native SUI send and a non-SUI mock-USDC send. Both assert balances move.
 */

test.describe.configure({ mode: 'serial' });

test('alice sends 0.5 SUI to bob; balances update', async ({ page }) => {
	await connectAs(page, 'alice');

	const aliceCell = page.getByTestId('balance-alice-sui');
	const bobCell = page.getByTestId('balance-bob-sui');

	await expect(aliceCell).not.toHaveText('…', { timeout: 10_000 });
	await expect(bobCell).not.toHaveText('…', { timeout: 10_000 });

	const aliceInitial = (await aliceCell.textContent()) ?? '';
	const bobInitial = (await bobCell.textContent()) ?? '';

	const sendCard = page.locator('section').filter({ hasText: /^Send/ });
	await selectAccount(sendCard.getByLabel(/^coin$/i), 'SUI');
	await selectAccount(sendCard.getByLabel(/recipient/i), 'bob');
	await sendCard.getByLabel(/amount/i).fill('0.5');
	await sendCard.getByRole('button', { name: /^Send$/ }).click();

	await expect(sendCard.getByText(/Last tx:/i)).toBeVisible({ timeout: 30_000 });

	await expect(aliceCell).not.toHaveText(aliceInitial, { timeout: 10_000 });
	await expect(bobCell).not.toHaveText(bobInitial, { timeout: 10_000 });
});

test('alice sends 100 mUSDC to bob; balances update', async ({ page }) => {
	await connectAs(page, 'alice');

	const aliceCell = page.getByTestId('balance-alice-musdc');
	const bobCell = page.getByTestId('balance-bob-musdc');

	await expect(aliceCell).not.toHaveText('…', { timeout: 10_000 });
	await expect(bobCell).not.toHaveText('…', { timeout: 10_000 });

	const aliceInitial = (await aliceCell.textContent()) ?? '';
	const bobInitial = (await bobCell.textContent()) ?? '';

	const sendCard = page.locator('section').filter({ hasText: /^Send/ });
	await selectAccount(sendCard.getByLabel(/^coin$/i), 'mUSDC');
	await selectAccount(sendCard.getByLabel(/recipient/i), 'bob');
	await sendCard.getByLabel(/amount/i).fill('100');
	await sendCard.getByRole('button', { name: /^Send$/ }).click();

	await expect(sendCard.getByText(/Last tx:/i)).toBeVisible({ timeout: 30_000 });
	await expect(aliceCell).not.toHaveText(aliceInitial, { timeout: 10_000 });
	await expect(bobCell).not.toHaveText(bobInitial, { timeout: 10_000 });
});
