// `registerCoin` — projects a published Move package's coin module
// into the manifest's `coins:` namespace. The dev-wallet's Faucet panel
// discovers mintable tokens through that list; the rest of the app
// reads `manifest.coins.find(c => c.name === 'musdc')` to resolve a
// human-readable name to a fully-qualified Move type at runtime.
//
//   const usdcPublish = publishMove({ name: 'musdc', path: USDC_DIR, signer, publish: publishViaSuiCli });
//   const usdcCoin    = registerCoin({
//       name: 'musdc',
//       package: usdcPublish.get('package'),
//       module: 'mock_usdc',
//       type:   'MOCK_USDC',
//       decimals: 6,
//   });
//   manifest({ packages: [usdcPublish.get('package')], coins: [usdcCoin.get('coin')] });
//
// The producer Deps on the upstream package's `Package` shape, so the
// engine wires the edge automatically and re-fires this projection
// whenever the upstream package id flips (a republish, a snapshot
// restore from a fresh chain).

import type { Dep, Provides } from '../engine/types.js';
import { dep } from '../factories/dep.js';
import { define } from '../factories/define.js';
import type { Coin, Package } from '../shapes/index.js';

export interface RegisterCoinOptions {
	/** Registry name (matches `Coin.name`). Frontends look the coin up
	 * via `manifest.coins.find(c => c.name === '<name>')`. */
	name: string;
	/** Dep returning the published `Package` shape — typically the
	 * result of `publishMove({...}).get('package')`. */
	package: Dep<Package>;
	/** Move module name within the package (`'managed_coin'`). */
	module: string;
	/** Coin type symbol within the module (`'MANAGED_COIN'`). */
	type: string;
	/** Coin decimals. */
	decimals: number;
}

const provides = {
	coin: dep((s: Coin) => s),
} satisfies Provides<Coin>;

export function registerCoin(opts: RegisterCoinOptions) {
	if (!opts.name) throw new Error('registerCoin: `name` is required');
	if (!opts.module) throw new Error(`registerCoin('${opts.name}'): \`module\` is required`);
	if (!opts.type) throw new Error(`registerCoin('${opts.name}'): \`type\` is required`);

	const deps = { package: opts.package };

	return define<Coin, typeof provides, typeof deps>({
		name: `registerCoin.${opts.name}`,
		deps,
		provides,
		inputs: ({ deps }) => {
			const resolved = deps as { package: Package };
			return {
				name: opts.name,
				module: opts.module,
				type: opts.type,
				decimals: opts.decimals,
				packageId: resolved.package.packageId,
			};
		},
		start: async ({ deps }) => {
			const resolved = deps as { package: Package };
			return {
				name: opts.name,
				type: `${resolved.package.packageId}::${opts.module}::${opts.type}`,
				decimals: opts.decimals,
			};
		},
		represents: {
			coins: (s: Coin): Coin[] => [s],
		},
	});
}
