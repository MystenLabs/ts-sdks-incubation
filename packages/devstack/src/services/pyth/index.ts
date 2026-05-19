// Pyth primitives — interface-driven multi-impl.
//
//   - `pythLocalDeploy(opts)` — publish a vendored Pyth Move package +
//     create PriceInfoObjects. Provides `PythTag`.
//   - `pythKnownPackage(opts)` — wrap canonical testnet/mainnet
//     deployments. Provides `PythTag` only.
//   - `PythPusher(opts)` — long-running fiber that pushes price
//     updates to chain. Consumes `PythTag`.
//   - `pythMid(opts)` — Ref helper that polls the on-chain
//     PriceInfoObject for a mid the maker can consume.

export { PythTag, type Pyth, type PythPriceInfo } from './tag.js';
export {
	pythLocalDeploy,
	type PythLocalDeployOptions,
	type PythLocalDeployFeedSpec,
} from './local-deploy.js';
export { pythKnownPackage, type PythKnownPackageOptions } from './known-deployment.js';
export {
	PythPusher,
	type PythPusherHandle,
	type PythPusherOptions,
	type PythPusherSource,
	type PythPriceUpdate,
} from './pusher.js';
export { pythMid, type PythMid, type PythMidOptions, type PythMidScale } from './mid.js';
export {
	SUI_PRICE_FEED_ID,
	DEEP_PRICE_FEED_ID,
	USDC_PRICE_FEED_ID,
	type PythPriceFeedId,
	type PythPriceInfoSpec,
} from './shared.js';
