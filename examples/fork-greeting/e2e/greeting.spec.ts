import { connectAs, expect, test } from '@mysten-incubation/devstack/playwright';

// alice connects, submits a greeting, then asserts the UI's Latest
// card surfaces the same text. Round-trip flow:
//   1. Connect (dev-wallet ConnectButton + per-account selector)
//   2. Type a unique greeting (timestamp suffix so re-runs don't false-positive)
//   3. Click "Send greeting"
//   4. Wait for the tx digest to surface
//   5. Wait for the polling read on the shared Board to flip
//
// The package + boardId come from the manifest's
// `packages.greeting.{id,captured.boardId}` slots — already wired into
// the generated code the UI consumes, so this spec is browser-only.
test('alice posts a greeting that round-trips through the shared Board', async ({ page }) => {
	await connectAs(page, 'alice');

	// boardId emitted into captured.ts — surfaces in the header.
	await expect(page.getByTestId('board-id')).not.toHaveText('(unset)');

	const unique = `hello fork ${Date.now()}`;
	const input = page.getByTestId('greeting-input');
	await input.fill(unique);

	await page.getByTestId('post-button').click();

	// Submit succeeded — tx digest line appears.
	await expect(page.getByTestId('post-tx')).toBeVisible({ timeout: 30_000 });

	// Polling read flips: the shared Board now reports the posted text.
	// 15s upper bound covers up to 10 polling cycles + a sui-fork
	// checkpoint advance.
	await expect(page.getByTestId('board-latest')).toHaveText(unique, { timeout: 15_000 });

	// Counter ticked up at least once (was 0 pre-post if this is the
	// first iteration; non-zero on subsequent runs against the same
	// chain). Non-strict — any positive integer is fine.
	const counter = await page.getByTestId('board-count').textContent();
	expect(Number(counter ?? '0')).toBeGreaterThan(0);
});
