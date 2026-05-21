// e2e for the rewrite-track template. Uses `@playwright/test` directly for
// `test` + `expect`; the devstack-rewrite playwright integration provides
// `connectAs` only.
//
// NOTE: this test will NOT pass end-to-end until the engine + supervisor
// land in `packages/devstack-rewrite/`. The migration target here is
// type-clean wiring (vite/playwright preset + devstack.config.ts shape).

import { expect, test } from '@playwright/test';
import { connectAs } from '@mysten-incubation/devstack-rewrite/playwright';

test('alice sends a greeting', async ({ page }) => {
	await connectAs(page, 'alice');

	await expect(page.getByTestId('package-id')).not.toHaveText('0x0');

	await page.getByTestId('mint-button').click();
	await expect(page.getByTestId('mint-tx')).toBeVisible({ timeout: 20_000 });
});
