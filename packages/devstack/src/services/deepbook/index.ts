// DeepBook v3 primitives — interface-driven multi-impl.
//
//   - `deepbookLocalDeploy(opts)`     → publish the deepbook-v3 Move
//     package + create the requested whitelisted pools. Provides all
//     three interface tags (`DeepbookCoreTag`, `DeepbookAdminTag`,
//     `DeepbookMarketMaker`) because the local deploy owns the admin
//     cap and can mint a BalanceManager.
//   - `deepbookKnownPackage(opts)`    → wrap an already-deployed
//     deepbook-v3 instance (e.g. canonical testnet/mainnet). Provides
//     only `DeepbookCoreTag` — no admin cap, no balance manager.
//   - `deepbookMarketMaker(opts)`     → long-running grid maker. A
//     CONSUMER that yields `DeepbookCoreTag` from Context, so it composes
//     against either local-deploy or known-package.
//
// Mechanical heir of `deepbook(opts)` + `deepbookMarketMaker(opts)`.
// Same Move calls, same fee math, same cadence — the surrounding
// plumbing is just split across multiple files now.

export type { DeepbookCoinRef, DeepbookPoolSpec, DeepbookPool } from './internal.js';
export {
	deepbookLocalDeploy,
	type DeepbookLocalDeployOptions,
	type DeepbookLocalDeployShape,
} from './local-deploy.js';
export { deepbookKnownPackage, type DeepbookKnownPackageOptions } from './known-deployment.js';
export {
	deepbookMarketMaker,
	type DeepbookMarketMakerHandle,
	type DeepbookMarketMakerOptions,
	type DeepbookMarketMakerPoolSpec,
	type DeepbookMarketMakerStrategy,
} from './market-maker.js';
export {
	DeepbookMintDEEP,
	DeepbookMintUSDC,
	type DeepbookMintDEEPOptions,
	type DeepbookMintUSDCOptions,
} from './mint.js';
export {
	vendorDeepbook,
	type VendorDeepbookOptions,
	type VendoredDeepbookSources,
} from './vendor.js';
export {
	DeepbookIndexer,
	DeepbookIndexerTag,
	type DeepbookIndexerOptions,
	type DeepbookIndexer as DeepbookIndexerShape,
} from './indexer.js';
export {
	DeepbookServer,
	DeepbookServerTag,
	type DeepbookServerOptions,
	type DeepbookServer as DeepbookServerShape,
} from './server.js';
export {
	deepbookMargin,
	DeepbookMarginTag,
	DEFAULT_POOL_RISK_CONFIG,
	USDC_MARGIN_DEFAULTS,
	SUI_MARGIN_DEFAULTS,
	type DeepbookMarginOptions,
	type DeepbookMargin as DeepbookMarginShape,
	type DeepbookMarginAssetConfig,
	type DeepbookMarginPoolRegistration,
	type DeepbookMarginPoolRiskConfig,
	type DeepbookMarginPool,
} from './margin.js';
export {
	deepbookMarginSeed,
	type DeepbookMarginSeedOptions,
	type DeepbookMarginSeedAmount,
	type DeepbookMarginSeedResult,
} from './margin-seed.js';
export {
	DEEPBOOK_IMAGES,
	DEFAULT_DEEPBOOK_MOVE_VERSION,
	getDeepbookImages,
	type DeepbookImagePair,
} from './images.js';
