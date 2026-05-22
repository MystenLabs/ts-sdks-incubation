import { expect, test } from '@playwright/test';

test('renders generated DeepBook and Pyth binding proof', async ({ page }) => {
	await page.goto('/');

	await expect(page.getByRole('heading', { name: 'DeepBook/Pyth Market Console' })).toBeVisible();
	await expect(page.getByTestId('deepbook-package-id')).toContainText('0x22be4c');
	await expect(page.getByTestId('deepbook-registry-id')).toContainText('0x7c256e');
	await expect(page.getByTestId('pyth-state-id')).toContainText('0x243759');
	await expect(page.getByTestId('pool-row-SUI_DBUSDC')).toBeVisible();
	await expect(page.getByTestId('market-proof-status')).toBeVisible();
});
