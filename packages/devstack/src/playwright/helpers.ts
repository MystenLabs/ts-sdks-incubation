import { type Locator, type Page, expect } from '@playwright/test';

/**
 * Click `<ConnectButton>`, pick the named dev wallet from the connect modal,
 * and assert the "Connected as <label>" surface is visible.
 *
 * Works against the dapp-kit-react Lit components: the connect button + modal
 * are web components; Playwright's CSS engine pierces shadow DOM in chained
 * locators.
 */
export async function connectAs(page: Page, label: string): Promise<void> {
	await page.goto('/');
	await page.locator('mysten-dapp-kit-connect-button').click();
	await page
		.locator('mysten-dapp-kit-connect-modal')
		.getByText(`Dev: ${label}`, { exact: true })
		.click();
	await expect(page.getByText(new RegExp(`Connected as.*${label}`, 'i'))).toBeVisible({
		timeout: 10_000,
	});
}

/**
 * `selectOption({ label: regex })` isn't supported by the DOM `<select>` API;
 * resolve the matching option's value attribute and pass it explicitly.
 */
export async function selectAccount(select: Locator, name: string): Promise<void> {
	const value = await select.locator('option').filter({ hasText: name }).getAttribute('value');
	if (!value) throw new Error(`No option matching ${name}`);
	await select.selectOption(value);
}

/**
 * Wait for a `data-testid="balance-<name>"` cell's text to match a predicate.
 * Useful for verifying that a tx invalidated and refetched a balance query.
 */
export async function waitForBalanceUpdate(
	page: Page,
	name: string,
	predicate: (text: string) => boolean,
	opts: { timeout?: number } = {},
): Promise<void> {
	const cell = page.getByTestId(`balance-${name}`);
	await expect
		.poll(async () => predicate((await cell.textContent()) ?? ''), {
			timeout: opts.timeout ?? 10_000,
		})
		.toBe(true);
}
