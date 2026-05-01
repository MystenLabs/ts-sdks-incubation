// Token-studio's app plugin. One Publish action: the `managed_coin` Move
// package, with M8 source-digest skip-on-warm. Captures TreasuryCap +
// CoinMetadata + UpgradeCap so the UI can mint via the cap and link the
// metadata badge.
//
// Mirrors examples/arena/arenaPlugin.ts; differs only in package layout (no
// shared-object Seed — token-studio's UI handles minting interactively).

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { definePlugin, definePublishAction } from '@mysten-incubation/devstack';

const HERE = dirname(fileURLToPath(import.meta.url));
const MANAGED_COIN_DIR = resolve(HERE, 'move/managed_coin');

export const tokenStudioPlugin = () =>
	definePlugin({
		name: 'token-studio',
		actions: () => [
			definePublishAction({
				name: 'managedCoin',
				needs: ['sui.accounts'],
				registryAs: 'managed_coin',
				sourcePath: MANAGED_COIN_DIR,
				// Alice publishes (and so receives the TreasuryCap). The
				// frontend gates the mint UI on `address === accounts.alice`,
				// so the deployer must be alice — avoids needing a
				// "who has the cap" lookup in the React tree.
				publisher: 'alice',
				capture: {
					treasuryCapId: '::coin::TreasuryCap<',
					metadataId: '::coin::CoinMetadata<',
					upgradeCapId: '0x2::package::UpgradeCap',
				},
				onPublished: (ctx, result) => {
					ctx.registry.tokens.register({
						name: 'managed_coin',
						type: `${result.packageId}::managed_coin::MANAGED_COIN`,
						decimals: 6,
					});
				},
			}),
		],
	});
