import { expect, test } from '@playwright/test';
import { connectAs } from '@mysten-incubation/devstack/playwright';

test.setTimeout(180_000);

test('alice stores a blob on Walrus and reads it back', async ({ page }) => {
	page.on('console', (m) => {
		if (m.type() === 'error') console.error('[console.error]', m.text());
	});

	await page.goto('/');
	await connectAs(page, 'alice');

	const walrus = page.locator('section').filter({ hasText: /^Walrus/ });
	const text = `stored · ${new Date().toISOString()}`;

	await walrus.getByLabel('Text').fill(text);
	await walrus.getByTestId('walrus-store').click();
	await expect(walrus.getByTestId('walrus-blob-id')).toBeVisible({ timeout: 90_000 });

	await walrus.getByTestId('walrus-read').click();
	await expect(walrus.getByTestId('walrus-readback')).toHaveText(text, { timeout: 60_000 });
});
