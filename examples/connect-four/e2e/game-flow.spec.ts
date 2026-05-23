import { expect, test, type Page } from '@playwright/test';

const clickColumn = async (page: Page, player: 'Alice' | 'Bob', column: number) => {
	await page.getByRole('button', { name: `Drop ${player} piece in column ${column}` }).click({
		timeout: 30_000,
	});
};

test('opens a lobby, seats bob, and plays an on-chain game', async ({ page }) => {
	await page.goto('/');

	await expect(page.getByRole('heading', { name: 'Connect Four' })).toBeVisible();
	await expect(page.getByText('Open the table')).toBeVisible();

	await page.getByRole('button', { name: 'Open as Alice' }).click();
	await expect(page.getByText('Seat Bob')).toBeVisible({ timeout: 30_000 });
	await expect(page.getByText('Lobby', { exact: true })).toBeVisible();

	await page.getByRole('button', { name: 'Join as Bob' }).click();
	await expect(page.getByText('Alice to move')).toBeVisible({ timeout: 30_000 });
	await expect(page.getByText('Game', { exact: true })).toBeVisible();

	await clickColumn(page, 'Alice', 1);
	await expect(page.getByText('Bob to move')).toBeVisible({ timeout: 30_000 });

	await clickColumn(page, 'Bob', 2);
	await expect(page.getByText('Alice to move')).toBeVisible({ timeout: 30_000 });
});
