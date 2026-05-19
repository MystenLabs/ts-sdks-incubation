// `localnetWalrusOptions(args)` — localnet-specific config inputs for
// `new WalrusClient(...)`. Returns the `packageConfig` from the
// walrus package's `captured.systemObject` / `captured.stakingObject`
// (populated by the `Walrus({...})` plugin's register step) plus
// `storageNodeUrlScheme: 'http'` — devstack storage nodes serve plain
// HTTP.
//
// Apps source the ids from the generated `captured.ts` and pass them
// in directly — keeps this helper decoupled from any specific manifest
// shape:
//
//     import { captured } from './generated/captured.js';
//     const w = (captured as Record<string, { systemObject?: string; stakingObject?: string }>)[
//       'walrus.walrus'
//     ];
//     if (!w?.systemObject || !w?.stakingObject) {
//       throw new Error('walrus not deployed yet');
//     }
//     const opts = localnetWalrusOptions({
//       systemObjectId: w.systemObject,
//       stakingPoolId: w.stakingObject,
//     });

export interface LocalnetWalrusOptions {
	/** `systemObjectId` + `stakingPoolId` for `WalrusClient`. */
	packageConfig: { systemObjectId: string; stakingPoolId: string };
	/** Always `'http'` — devstack storage nodes serve plain HTTP. */
	storageNodeUrlScheme: 'http';
}

export interface LocalnetWalrusInputs {
	systemObjectId: string;
	stakingPoolId: string;
}

export function localnetWalrusOptions(args: LocalnetWalrusInputs): LocalnetWalrusOptions {
	return {
		packageConfig: {
			systemObjectId: args.systemObjectId,
			stakingPoolId: args.stakingPoolId,
		},
		storageNodeUrlScheme: 'http',
	};
}
