import { expect, test, type Page } from '@playwright/test';
import { connectAs } from '@mysten-incubation/devstack/playwright';

// The contextual status line — "Your move" / "Opponent's turn" also appear in
// the move banner, so scope status assertions to the `aria-live` status
// paragraph to keep locators unambiguous.
const status = (page: Page) => page.locator('p.status');

const playColumn = async (page: Page, column: number) => {
	await page.getByRole('button', { name: `Play column ${column}` }).click({
		timeout: 30_000,
	});
};

// The app acts as the CONNECTED account only — account switching is driven
// by the test via `connectAs`, never by the app. Alice creates the lobby
// (becomes player A), bob joins (becomes player B), then the two seats
// alternate moves, switching the active wallet account between turns.
test('opens a lobby, seats bob, and plays an on-chain game', async ({ page }) => {
	await page.goto('/');

	await expect(page.getByRole('heading', { name: 'Connect Four' })).toBeVisible();

	// Alice is the active account: she opens the lobby and becomes player A.
	await connectAs(page, 'alice');
	await expect(status(page)).toHaveText('Create a lobby to start');

	await page.getByRole('button', { name: 'Create Lobby' }).click();
	await expect(status(page)).toContainText('You are Player A', { timeout: 30_000 });
	await expect(page.getByText('Lobby', { exact: true })).toBeVisible();

	// Switch to bob (a DIFFERENT connected account) and join as player B.
	await connectAs(page, 'bob');
	await page.getByRole('button', { name: 'Join Lobby' }).click();
	await expect(page.getByText('Game', { exact: true })).toBeVisible({ timeout: 30_000 });
	// Game has started — player A (alice) moves first, so from bob's seat it
	// is the opponent's turn.
	await expect(status(page)).toHaveText("Opponent's turn", { timeout: 30_000 });

	// Alice's turn: switch back, and she should be able to move.
	await connectAs(page, 'alice');
	await expect(status(page)).toHaveText('Your move', { timeout: 30_000 });
	await playColumn(page, 1);
	await expect(status(page)).toHaveText("Opponent's turn", { timeout: 30_000 });

	// Bob's turn: switch to bob and play.
	await connectAs(page, 'bob');
	await expect(status(page)).toHaveText('Your move', { timeout: 30_000 });
	await playColumn(page, 2);
	await expect(status(page)).toHaveText("Opponent's turn", { timeout: 30_000 });
});
