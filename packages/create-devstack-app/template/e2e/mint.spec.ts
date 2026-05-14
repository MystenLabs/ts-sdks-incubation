import { connectAs, expect, test } from '@mysten-incubation/devstack-effect/playwright';

test('alice sends a greeting', async ({ page }) => {
	await connectAs(page, 'alice');

	await expect(page.getByTestId('package-id')).not.toHaveText('0x0');

	await page.getByTestId('mint-button').click();
	await expect(page.getByTestId('mint-tx')).toBeVisible({ timeout: 20_000 });
});
