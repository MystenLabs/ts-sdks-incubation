import { expect, test } from '@playwright/test';
import { connectAs } from '@mysten-incubation/devstack/playwright';

/**
 * End-to-end Seal demo: alice encrypts + uploads, grants a Cap to bob, then
 * bob (after a fresh page load + connect-as) decrypts.
 *
 * Real Vite dev server, real Sui localnet, real Walrus stack, real local
 * Seal key server — no mocks. Exercises the full SealClient.encrypt →
 * upload_entry → grant_entry → SessionKey.create → seal_approve dry-run →
 * fetchKeys → SealClient.decrypt round trip.
 *
 * SCOPE: this spec runs entirely within a single devstack lifecycle —
 * Playwright's `webServer` owns the stack, so we cannot tear it down and
 * bring it back up mid-test. The "old content stops decrypting after a
 * restart" failure (a warm restart must reuse the same vault packageId,
 * Seal key-server objectId, Walrus systemObjectId, and Sui chainId rather
 * than republish) is therefore covered at the devstack e2e layer instead:
 * see `packages/devstack/test/e2e/private-content-boot.test.ts`, which does
 * a real cold→warm boot cycle and pins those ids stable across the restart.
 */

const PLAINTEXT = `secret · ${new Date().toISOString()}`;
const FILENAME = `e2e-${Date.now()}.txt`;

test.setTimeout(180_000);

// Buffer browser console errors and surface them ONLY when a test fails, so a
// green run stays quiet. dapp-kit auto-registers the hosted Slush wallet, whose
// metadata fetch errors out against a localnet (expected, stack-independent
// noise); printing every console error inline drowned the key-server / vault
// errors we actually want a hint about. On failure we dump the buffer.
const browserConsoleErrors: string[] = [];
test.beforeEach(({ page }) => {
	browserConsoleErrors.length = 0;
	page.on('console', (m) => {
		if (m.type() === 'error') browserConsoleErrors.push(m.text());
	});
});
// Playwright requires the first hook arg to be an object-destructuring pattern
// even when no fixture is used; `no-empty-pattern` flags the resulting `{}`.
// eslint-disable-next-line no-empty-pattern
test.afterEach(({}, testInfo) => {
	if (testInfo.status !== testInfo.expectedStatus && browserConsoleErrors.length > 0) {
		console.error(
			`[browser console errors during failed test]\n  ${browserConsoleErrors.join('\n  ')}`,
		);
	}
});

/**
 * Read the full (untruncated) address of the currently connected account
 * from the app's `connected-account` slot. The app intentionally exposes
 * the full address via a `data-address` attribute (the visible label is
 * truncated) so prod-path code never needs the dev `accounts` map — and
 * this spec resolves the address it needs through the running app rather
 * than importing the gitignored generated accounts module.
 */
async function connectedAddress(page: import('@playwright/test').Page): Promise<string> {
	const slot = page.getByTestId('connected-account');
	await expect(slot).toBeVisible({ timeout: 15_000 });
	const address = await slot.getAttribute('data-address');
	expect(address).toMatch(/^0x[0-9a-f]+$/);
	return address as string;
}

test('alice encrypts + uploads, grants bob a cap, bob decrypts', async ({ page }) => {
	// (Browser console errors are buffered in `beforeEach` and surfaced only on
	// failure — see the afterEach hook above.)

	// --- resolve bob's address through the app (no dev accounts import) ---
	// Connect as bob first purely to read his full address from the
	// `connected-account` slot, then clear the persisted session so alice
	// starts clean. The grant later targets this address via the free-form
	// recipient input.
	await page.goto('/');
	await connectAs(page, 'bob');
	const bobAddress = await connectedAddress(page);
	await page.goto('/');
	await page.evaluate(() => localStorage.clear());

	// --- alice: upload ---
	await page.goto('/');
	await connectAs(page, 'alice');

	const uploadCard = page.locator('section').filter({ hasText: /^Upload/ });
	await uploadCard.getByTestId('upload-name').fill(FILENAME);
	await uploadCard.getByTestId('upload-content').fill(PLAINTEXT);
	await uploadCard.getByTestId('upload-submit').click();
	await expect(uploadCard.getByTestId('upload-tx')).toBeVisible({ timeout: 30_000 });

	// File row appears in alice's MyFiles after the cap query refetches.
	const fileRow = page.getByTestId(`file-row-${FILENAME}`);
	await expect(fileRow).toBeVisible({ timeout: 15_000 });

	// Capture the new file's object id from the row before the grant —
	// re-running the spec accumulates Caps on-chain for prior runs, and
	// the GrantForm's "first owned cap" default would otherwise pick a
	// stale file. The id is rendered as a `<p>` under the row.
	const fileId = (await fileRow.locator('p.font-mono').first().textContent())?.trim() ?? '';
	expect(fileId).toMatch(/^0x[0-9a-f]+$/);

	// alice round-trip sanity-check: she has the admin Cap, so decrypt
	// should reveal the same plaintext she just uploaded.
	await fileRow.getByTestId(`decrypt-${FILENAME}`).click();
	await expect(page.getByTestId(`plaintext-${FILENAME}`)).toHaveText(PLAINTEXT, {
		timeout: 30_000,
	});

	// --- alice: grant a cap to bob for the same file ---
	const grantCard = page.locator('section').filter({ hasText: /^Grant access/ });
	await grantCard.getByLabel(/^file$/i).selectOption(fileId);
	await grantCard.getByTestId('grant-recipient').fill(bobAddress);
	await grantCard.getByTestId('grant-submit').click();
	await expect(grantCard.getByTestId('grant-tx')).toBeVisible({ timeout: 30_000 });

	// --- bob: fresh load, switch wallet, decrypt ---
	// dapp-kit persists the connected wallet in localStorage, so a plain
	// page.goto would keep alice's session. Clear before bob connects.
	await page.goto('/');
	await page.evaluate(() => localStorage.clear());
	await connectAs(page, 'bob');
	const bobFileRow = page.getByTestId(`file-row-${FILENAME}`);
	await expect(bobFileRow).toBeVisible({ timeout: 15_000 });

	await bobFileRow.getByTestId(`decrypt-${FILENAME}`).click();
	await expect(page.getByTestId(`plaintext-${FILENAME}`)).toHaveText(PLAINTEXT, {
		timeout: 30_000,
	});
});
