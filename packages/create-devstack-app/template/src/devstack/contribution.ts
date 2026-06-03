// Shape of an optional plugin's contribution to the stack config.
//
// Each optional plugin (walrus, seal, deepbook) lives in its own module that
// exports a `setup()` returning the refs the core `devstack.config.ts` needs
// to splice in: extra funding for the demo account, extra dev-wallet accounts,
// and extra `after:` dependencies for the vite host service. Core spreads
// these in deterministic plugin order. No text splicing — the scaffolder just
// chooses which modules the generated `plugins.ts` barrel re-exports.

import type { account, AnyPlugin, WalletAccountMember } from '@mysten-incubation/devstack';

/** A funding entry as accepted by `account({ funding })`. */
export type FundingEntry = NonNullable<Parameters<typeof account>[1]>['funding'] extends
	| ReadonlyArray<infer E>
	| undefined
	? E
	: never;

/** What an optional plugin contributes to the core stack config. Every field
 *  is optional; a plugin only fills the slots it needs. */
export interface PluginContribution {
	/** Extra funding entries appended to the demo account (`alice`). */
	readonly fundingForAlice?: ReadonlyArray<FundingEntry>;
	/** Extra accounts registered in the dev wallet (e.g. seal's publisher).
	 *  These are `account(...)` results, branded as wallet members. */
	readonly walletAccounts?: ReadonlyArray<WalletAccountMember>;
	/** Extra members the vite host service must wait for (`after:`). */
	readonly after?: ReadonlyArray<AnyPlugin>;
}

/** Context handed to each plugin's `setup()`. Kept minimal; today plugins need
 *  nothing from core, but threading a context keeps the signature stable as the
 *  template grows (e.g. passing `localnet` or `HERE`). */
export interface PluginContext {
	/** Absolute path of the app directory (the dir holding devstack.config.ts),
	 *  for plugins that publish a local Move package. */
	readonly here: string;
}

/** A plugin module: a stable id plus a pure `setup()` producing its
 *  contribution. */
export interface PluginModule {
	readonly id: string;
	setup(ctx: PluginContext): PluginContribution;
}
