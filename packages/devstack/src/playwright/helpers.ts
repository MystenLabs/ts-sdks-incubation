import { type Locator, type Page, expect } from '@playwright/test';

/**
 * Click `<ConnectButton>`, connect the dev wallet (one wallet exposing every
 * account devstack resolved), and retarget dApp Kit's current account to the
 * one labelled `label`. Asserts the page's `Connected as <label>` surface is
 * visible.
 *
 * The dev wallet is registered as a single `Dev Wallet` whose `accounts`
 * list mirrors the devstack-resolved set. dApp Kit auto-connects to the
 * first account; we then call dApp Kit's `switchAccount({ account })` to
 * retarget without rebuilding the connection — `createDevstackDappKit`
 * exposes the kit on `globalThis.__devstackDAppKit__`.
 */
export async function connectAs(page: Page, label: string): Promise<void> {
	await page.goto('/');
	await page.locator('mysten-dapp-kit-connect-button').click();
	await page
		.locator('mysten-dapp-kit-connect-modal')
		.getByText('Dev Wallet', { exact: true })
		.click();
	await expect(page.getByText(/Connected as/i)).toBeVisible({ timeout: 10_000 });
	await page.evaluate((labelArg) => {
		interface UiAccount {
			label?: string;
			address: string;
		}
		interface UiWallet {
			name: string;
			accounts: ReadonlyArray<UiAccount>;
		}
		interface DevstackDappKit {
			stores: { $wallets: { get(): ReadonlyArray<UiWallet> } };
			switchAccount: (args: { account: UiAccount }) => void;
		}
		const slot = globalThis as { __devstackDAppKit__?: DevstackDappKit };
		const kit = slot.__devstackDAppKit__;
		if (kit === undefined) throw new Error('connectAs: globalThis.__devstackDAppKit__ missing');
		const wallet = kit.stores.$wallets.get().find((w) => w.name === 'Dev Wallet');
		if (wallet === undefined) throw new Error('connectAs: Dev Wallet not registered');
		const account = wallet.accounts.find(
			(a) => (a.label ?? '').toLowerCase() === labelArg.toLowerCase(),
		);
		if (account === undefined) {
			throw new Error(`connectAs: no account labelled "${labelArg}" on Dev Wallet`);
		}
		kit.switchAccount({ account });
	}, label);
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
