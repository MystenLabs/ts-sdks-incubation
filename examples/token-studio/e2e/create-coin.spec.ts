import { expect, test, type Locator, type Page } from '@playwright/test';
import { connectAs } from '@mysten-incubation/devstack/playwright';

/**
 * Happy-path: alice (TreasuryCap holder) mints STUDIO to bob, then bob
 * transfers STUDIO to carol. Real Vite dev server, real Sui localnet, real
 * wallet-standard adapter and approval UI — no mocks.
 */

test.describe.configure({ mode: 'serial' });

const STUDIO_DISPLAY_UNIT = 100;

const studio = (whole: number) => whole * STUDIO_DISPLAY_UNIT;

const selectOptionStartingWith = async (select: Locator, text: string) => {
	const value = await select
		.locator('option')
		.filter({ hasText: new RegExp(`^${text}\\b`) })
		.first()
		.getAttribute('value');
	expect(value, `option starting with "${text}"`).not.toBeNull();
	await select.selectOption(value!);
};

const readStudioBalance = async (page: Page, accountName: string): Promise<number> => {
	const balance = page.getByTestId(`balance-${accountName}-studio`);
	await expect(balance).not.toHaveText(/[—…]/, { timeout: 15_000 });

	const text = (await balance.textContent())?.trim() ?? '';
	const match = /^(\d+)\.(\d{2})$/.exec(text);
	expect(match, `${accountName} STUDIO balance should be a fixed 2-decimal amount`).not.toBeNull();
	return Number(match![1]) * STUDIO_DISPLAY_UNIT + Number(match![2]);
};

const expectStudioBalance = async (page: Page, accountName: string, expected: number) => {
	await expect
		.poll(() => readStudioBalance(page, accountName), {
			message: `${accountName} STUDIO balance`,
			timeout: 15_000,
		})
		.toBe(expected);
};

test('alice mints STUDIO to bob, then bob transfers STUDIO to carol', async ({ page }) => {
	await page.goto('/');
	await connectAs(page, 'alice');
	await expect(page.getByText('TreasuryCap holder', { exact: true })).toBeVisible();

	const bobBeforeMint = await readStudioBalance(page, 'bob');
	const carolBeforeMint = await readStudioBalance(page, 'carol');

	const mintCard = page.locator('section').filter({ hasText: /^Mint/ });
	await selectOptionStartingWith(mintCard.getByLabel(/recipient/i), 'bob');
	await mintCard.getByLabel(/amount/i).fill('17');
	await mintCard.getByRole('button', { name: /^Mint$/ }).click();

	await expect(mintCard.getByText(/Last tx:/i)).toBeVisible({ timeout: 20_000 });
	await expectStudioBalance(page, 'bob', bobBeforeMint + studio(17));
	await expectStudioBalance(page, 'carol', carolBeforeMint);

	await connectAs(page, 'bob');
	await expect(page.getByText('TreasuryCap holder', { exact: true })).toHaveCount(0);
	// Mint is gated on ACTUAL TreasuryCap ownership (queried on-chain), not on
	// wallet order — so a non-holder (bob) must NOT see the Mint form.
	await expect(page.locator('section').filter({ hasText: /^Mint/ })).toHaveCount(0);

	const bobBeforeTransfer = await readStudioBalance(page, 'bob');
	const carolBeforeTransfer = await readStudioBalance(page, 'carol');

	const transferCard = page.locator('section').filter({ hasText: /^Transfer/ });
	await selectOptionStartingWith(transferCard.getByLabel(/recipient/i), 'carol');
	await transferCard.getByLabel(/amount/i).fill('5');
	await transferCard.getByRole('button', { name: /^Transfer$/ }).click();

	await expect(transferCard.getByText(/Last tx:/i)).toBeVisible({ timeout: 20_000 });
	await expectStudioBalance(page, 'bob', bobBeforeTransfer - studio(5));
	await expectStudioBalance(page, 'carol', carolBeforeTransfer + studio(5));
});
