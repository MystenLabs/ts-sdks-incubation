import { expect, test, type Locator } from '@playwright/test';
import { connectAs } from '@mysten-incubation/devstack/playwright';

/**
 * Happy-path: alice (TreasuryCap holder) mints STUDIO to bob and the digest
 * surfaces in the UI. Real Vite dev server, real Sui localnet, real
 * wallet-standard adapter — no mocks.
 */

test.describe.configure({ mode: 'serial' });

const selectOptionStartingWith = async (select: Locator, text: string) => {
	const value = await select
		.locator('option')
		.filter({ hasText: new RegExp(`^${text}\\b`) })
		.first()
		.getAttribute('value');
	expect(value, `option starting with "${text}"`).not.toBeNull();
	await select.selectOption(value!);
};

test('alice mints STUDIO to bob', async ({ page }) => {
	await page.goto('/');
	await connectAs(page, 'alice');
	await expect(page.getByText('TreasuryCap holder', { exact: true })).toBeVisible();

	const mintCard = page.locator('section').filter({ hasText: /^Mint/ });
	await selectOptionStartingWith(mintCard.getByLabel(/recipient/i), 'bob');
	await mintCard.getByLabel(/amount/i).fill('17');
	await mintCard.getByRole('button', { name: /^Mint$/ }).click();

	await expect(mintCard.getByText(/Last tx:/i)).toBeVisible({ timeout: 20_000 });
});

test('bob transfers STUDIO to carol', async ({ page }) => {
	await page.goto('/');
	await connectAs(page, 'bob');
	await expect(page.getByText('TreasuryCap holder', { exact: true })).toHaveCount(0);

	const transferCard = page.locator('section').filter({ hasText: /^Transfer/ });
	await selectOptionStartingWith(transferCard.getByLabel(/recipient/i), 'carol');
	await transferCard.getByLabel(/amount/i).fill('5');
	await transferCard.getByRole('button', { name: /^Transfer$/ }).click();

	await expect(transferCard.getByText(/Last tx:/i)).toBeVisible({ timeout: 20_000 });
});
