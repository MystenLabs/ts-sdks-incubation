import { expect, test } from '@playwright/test';
import { connectAs } from '@mysten-incubation/devstack/playwright';

test.setTimeout(120_000);

test('alice creates a shared counter and increments it on chain', async ({ page }) => {
	await page.goto('/');
	await connectAs(page, 'alice');

	const counter = page.locator('section').filter({ hasText: /^Counter/ });

	await counter.getByTestId('counter-create').click();
	await expect(counter.getByTestId('counter-id')).toBeVisible({ timeout: 60_000 });
	await expect(counter.getByTestId('counter-value')).toHaveText('0', { timeout: 30_000 });

	await counter.getByTestId('counter-increment').click();
	await expect(counter.getByTestId('counter-value')).toHaveText('1', { timeout: 30_000 });
});
