import { expect, test } from '@playwright/test';
import { connectAs } from '@mysten-incubation/devstack/playwright';

test.setTimeout(180_000);

test('alice places a resting bid on the DEEP/SUI pool', async ({ page }) => {
	page.on('console', (m) => {
		if (m.type() === 'error') console.error('[console.error]', m.text());
	});

	await page.goto('/');
	await connectAs(page, 'alice');

	const deepbook = page.locator('section').filter({ hasText: /^DeepBook/ });

	// The pool panel renders the seeded DEEP/SUI ids from the generated binding.
	await expect(deepbook.getByTestId('deepbook-pool')).toBeVisible({ timeout: 60_000 });
	await expect(deepbook.getByTestId('deepbook-pool')).toContainText('DEEP');

	// Two-tx order flow (create BalanceManager, then deposit + place order).
	// Localnet timing is generous; we assert the order was accepted (a digest
	// is surfaced), not that it filled — a below-market bid rests on the book.
	await deepbook.getByTestId('deepbook-place-order').click();
	await expect(deepbook.getByTestId('deepbook-order-result')).toBeVisible({ timeout: 120_000 });
	await expect(deepbook.getByTestId('deepbook-order-result')).not.toBeEmpty();
});
