// DeepBook v3 primitives — interface-driven multi-impl.
//
//   - `deepbookLocalDeploy(opts)`     → publish the deepbook-v3 Move
//     package + create the requested whitelisted pools. Provides all
//     three interface tags (`DeepbookCore`, `DeepbookAdmin`,
//     `DeepbookMarketMaker`) because the local deploy owns the admin
//     cap and can mint a BalanceManager.
//   - `deepbookKnownPackage(opts)`    → wrap an already-deployed
//     deepbook-v3 instance (e.g. canonical testnet/mainnet). Provides
//     only `DeepbookCore` — no admin cap, no balance manager.
//   - `deepbookMarketMaker(opts)`     → long-running grid maker. A
//     CONSUMER that yields `DeepbookCore` from Context, so it composes
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
export {
	deepbookKnownPackage,
	type DeepbookKnownPackageOptions,
} from './known-package.js';
export {
	deepbookMarketMaker,
	type DeepbookMarketMakerHandle,
	type DeepbookMarketMakerOptions,
	type DeepbookMarketMakerPoolSpec,
} from './market-maker.js';
