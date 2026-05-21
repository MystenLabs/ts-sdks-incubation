// e2e for the template. Uses `@playwright/test` directly for
// `test` + `expect`; the devstack playwright integration provides
// `connectAs` only.
//
// NOTE: this test is the type-clean wiring target for the Vite and
// Playwright preset plus the devstack config shape.

import { expect, test } from '@playwright/test';
import { connectAs } from '@mysten-incubation/devstack/playwright';

test('alice sends a greeting', async ({ page }) => {
	await connectAs(page, 'alice');

	await expect(page.getByTestId('package-id')).not.toHaveText('0x0');

	await page.getByTestId('mint-button').click();
	await expect(page.getByTestId('mint-tx')).toBeVisible({ timeout: 20_000 });
});
