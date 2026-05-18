import { Effect } from 'effect';
import { tag, setPhase, type LayeredTag } from '../advanced/tag.js';
import { publishCoin } from '../engine/registries.js';
import { toSdkCoin } from '../services/package.js';

// Projects a published Move coin module into the manifest's `coins:`
// namespace. dapp-kit's Faucet panel reads that list to discover mintable
// tokens; app code resolves a human-readable name to a fully-qualified
// Move type via `manifest.coins.find(c => c.name === '<name>')`.
//
//   const usdcPublish = publishMove({ name: 'musdc', path: USDC_DIR, signer: alice });
//   const usdcCoin    = registerCoin({
//       name: 'musdc',
//       package: usdcPublish,
//       module: 'mock_usdc',
//       type:   'MOCK_USDC',
//       decimals: 6,
//   });
//
// `publishMove({ coins: [...] })` already registers coins itself; this
// primitive exists for the case where the coin type is declared in a
// vendored package the app doesn't publish via the `coins:` shortcut
// (the only error-free path is registry registration, so no
// `RegisterCoinError` is emitted).

export interface RegisterCoinResult {
	readonly name: string;
	readonly packageId: string;
	readonly module: string;
	readonly type: string;
	readonly decimals: number;
	readonly fullCoinType: string;
	/**
	 * SDK-aligned projection — see `Coin['sdkCoin']`. Pass directly
	 * to `@mysten/deepbook-v3` utilities that accept the SDK's `CoinTag`
	 * shape.
	 */
	readonly sdkCoin: {
		readonly address: string;
		readonly type: string;
		readonly scalar: number;
	};
}

// `package` is generic over the tag's shape so the richer
// `Package<TCaptured, TCoins>` from `publishMove` qualifies alongside
// bare `{ packageId }` tags. `Context.Service` is invariant in its
// value parameter, so we can't widen via `& Record<string, unknown>`
// — capture the concrete type with a generic parameter constrained
// to carry `packageId`.
export interface RegisterCoinOptions<P extends { readonly packageId: string }> {
	readonly name: string;
	readonly package: LayeredTag<any, P, any, any>;
	readonly module: string;
	readonly type: string;
	readonly decimals: number;
}

export const registerCoin = <P extends { readonly packageId: string }>(
	options: RegisterCoinOptions<P>,
) =>
	tag(
		`registerCoin/${options.name}` as const,
		Effect.fn(`registerCoin(${options.name})`)(function* () {
			const pkg = yield* options.package;
			const fullCoinType = `${pkg.packageId}::${options.module}::${options.type}`;
			const sdkCoin = toSdkCoin({ fullCoinType, decimals: options.decimals });

			yield* Effect.annotateCurrentSpan({
				'registerCoin.name': options.name,
				'registerCoin.packageId': pkg.packageId,
				'registerCoin.type': fullCoinType,
			});

			yield* setPhase('registering');
			yield* publishCoin({
				name: options.name,
				type: fullCoinType,
				decimals: options.decimals,
				sdkCoin,
			});

			return {
				name: options.name,
				packageId: pkg.packageId,
				module: options.module,
				type: options.type,
				decimals: options.decimals,
				fullCoinType,
				sdkCoin,
			} satisfies RegisterCoinResult;
		})(),
		{
			kind: 'action',
			displayTitle: `coin.${options.name}`,
			display: (s) => ({ title: `coin.${s.name}`, primary: s.fullCoinType }),
		},
	);
