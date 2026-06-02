import { expect, test } from '@playwright/test';
import { connectAs } from '@mysten-incubation/devstack/playwright';

test.setTimeout(180_000);

test('alice encrypts a secret and decrypts it back', async ({ page }) => {
	page.on('console', (m) => {
		if (m.type() === 'error') console.error('[console.error]', m.text());
	});

	await page.goto('/');
	await connectAs(page, 'alice');

	const seal = page.locator('section').filter({ hasText: /^Seal/ });
	const secret = `secret · ${new Date().toISOString()}`;

	await seal.getByLabel('Secret').fill(secret);
	await seal.getByTestId('seal-encrypt').click();
	await expect(seal.getByTestId('seal-encrypted')).toBeVisible({ timeout: 60_000 });

	await seal.getByTestId('seal-decrypt').click();
	await expect(seal.getByTestId('seal-decrypted')).toHaveText(secret, { timeout: 60_000 });
});
