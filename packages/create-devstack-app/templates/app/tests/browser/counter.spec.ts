import { expect, test } from '@playwright/test';
import { connectAs } from '@mysten-incubation/devstack/playwright';

// Drives the REAL counter UI (src/App.tsx) end to end: the test only switches
// the connected account via `connectAs` — every transaction is signed by the
// app through the dapp-kit wallet adapter (`dAppKit.signAndExecuteTransaction`),
// registered with the devstack test bridge in `src/dapp-kit.ts`. The on-chain
// result is asserted by reading the value the app renders back from the chain.
test('connects, creates a counter, and increments it on chain', async ({ page }) => {
	await page.goto('/');

	await expect(page.getByRole('heading', { name: 'Counter' })).toBeVisible();

	// `alice` is the wallet account the app template's `devstack.config.ts`
	// funds. Connecting drives a real wallet-standard connection through the
	// injected dev wallet.
	await connectAs(page, 'alice');
	await expect(page.getByText(/Connected as/)).toBeVisible({ timeout: 30_000 });

	// Create + share a fresh Counter (signed via the dapp-kit adapter). The app
	// waits for indexing, then renders the new object's id and its value (0).
	await page.getByRole('button', { name: 'Create counter' }).click();
	const value = page.locator('span.value');
	await expect(value).toHaveText('0', { timeout: 30_000 });

	// Increment once — the on-chain value the app reads back must become 1.
	await page.getByRole('button', { name: 'Increment' }).click();
	await expect(value).toHaveText('1', { timeout: 30_000 });
});
