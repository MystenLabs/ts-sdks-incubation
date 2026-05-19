// `toSdkCoin` — pure projection from `(fullCoinType, decimals)` to the
// SDK-aligned coin entry consumed by `@mysten/deepbook-v3` (and any
// dapp-kit utility that accepts the same `{address, type, scalar}`
// shape).
//
// Lives in `runtime/` because the manifest's `SdkCoinEntry` is the
// canonical destination — the projection is what bridges our internal
// `(fullCoinType, decimals)` storage to the on-disk + on-snapshot
// `sdkCoin` shape. Re-exported from `services/package.ts` so service
// code that builds Coin entries imports from the same module as
// `Coin` / `CoinTag`.

export interface SdkCoin {
	readonly address: string;
	readonly type: string;
	readonly scalar: number;
}

export const toSdkCoin = (opts: {
	readonly fullCoinType: string;
	readonly decimals: number;
}): SdkCoin => {
	const sep = opts.fullCoinType.indexOf('::');
	const address = sep === -1 ? opts.fullCoinType : opts.fullCoinType.slice(0, sep);
	return {
		address,
		type: opts.fullCoinType,
		scalar: 10 ** opts.decimals,
	};
};
