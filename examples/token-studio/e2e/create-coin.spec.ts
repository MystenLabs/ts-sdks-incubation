import { expect, test } from '@playwright/test';

import { connectAs, selectAccount } from '@mysten-incubation/devstack/playwright';

/**
 * Happy-path: alice (TreasuryCap holder) mints STUDIO to bob and the digest
 * surfaces in the UI. Real Vite dev server, real Sui localnet, real
 * wallet-standard adapter — no mocks.
 */

test.describe.configure({ mode: 'serial' });

test('alice mints STUDIO to bob', async ({ page }) => {
	await connectAs(page, 'alice');
	await expect(page.getByText('TreasuryCap holder', { exact: true })).toBeVisible();

	const mintCard = page.locator('section').filter({ hasText: /^Mint/ });
	await selectAccount(mintCard.getByLabel(/recipient/i), 'bob');
	await mintCard.getByLabel(/amount/i).fill('17');
	await mintCard.getByRole('button', { name: /^Mint$/ }).click();

	await expect(mintCard.getByText(/Last tx:/i)).toBeVisible({ timeout: 20_000 });
});

test('bob transfers STUDIO to carol', async ({ page }) => {
	await connectAs(page, 'bob');
	await expect(page.getByText('TreasuryCap holder', { exact: true })).toHaveCount(0);

	const transferCard = page.locator('section').filter({ hasText: /^Transfer/ });
	await selectAccount(transferCard.getByLabel(/recipient/i), 'carol');
	await transferCard.getByLabel(/amount/i).fill('5');
	await transferCard.getByRole('button', { name: /^Transfer$/ }).click();

	await expect(transferCard.getByText(/Last tx:/i)).toBeVisible({ timeout: 20_000 });
});
