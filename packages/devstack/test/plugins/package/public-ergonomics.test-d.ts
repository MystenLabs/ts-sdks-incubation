import { defineDevstack } from '../../../src/api/define-devstack.ts';
import { account } from '../../../src/plugins/account/index.ts';
import { action } from '../../../src/plugins/action/index.ts';
import { coin } from '../../../src/plugins/coin/index.ts';
import { localPackage } from '../../../src/plugins/package/index.ts';
import { sui } from '../../../src/plugins/sui/index.ts';
import type { ResourceValueOf } from '../../../src/substrate/plugin.ts';

const localnet = sui();
const publisher = account('publisher');
const alice = account('alice');
const bob = account('bob');

const greeting = localPackage('greeting', {
	sourcePath: '/fixtures/greeting',
	publisher,
	capture: { boardId: '::board::Board' },
});

declare const resolvedGreeting: ResourceValueOf<typeof greeting>;
export const _capturedBoardId: string = resolvedGreeting.captured.boardId;
export const _capturedPackageCoinRef = coin.fromPackage(greeting, 'GREETING');

const usdc = localPackage('mock_usdc', {
	sourcePath: '/fixtures/mock_usdc',
	publisher,
});
const weth = localPackage('mock_weth', {
	sourcePath: '/fixtures/mock_weth',
	publisher,
});

const mUSDC = coin.fromPackage(usdc, 'MOCK_USDC');
const mWETH = coin.fromPackage(weth, 'MOCK_WETH');

const seedTokens = action('wallet.seedTokens', {
	dependsOn: { usdc, weth, publisher, alice, bob },
	body: (ctx, { usdc, weth, publisher, alice, bob }) =>
		ctx.signAndExecute(publisher, (tx) => {
			const recipients = [alice.address, bob.address];
			const specs = [
				{ pkg: usdc, coin: usdc.coins.mock_usdc, module: 'mock_usdc' },
				{ pkg: weth, coin: weth.coins.mock_weth, module: 'mock_weth' },
			] as const;

			for (const spec of specs) {
				if (spec.coin?.treasuryCapId === undefined) continue;
				for (const recipient of recipients) {
					tx.moveCall({
						target: `${spec.pkg.packageId}::${spec.module}::mint`,
						arguments: [
							tx.object(spec.coin.treasuryCapId),
							tx.pure.u64(1_000_000n),
							tx.pure.address(recipient),
						],
					});
				}
			}
		}),
});

export const _stack = defineDevstack({
	members: [localnet, publisher, alice, bob, greeting, usdc, weth, mUSDC, mWETH, seedTokens],
});

type NoWitnessNamespace = typeof coin extends { readonly witness: unknown } ? never : true;
export const _coinWitnessRemoved: NoWitnessNamespace = true;
