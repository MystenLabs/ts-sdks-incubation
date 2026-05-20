// `localnetWalrusOptions(args)` — localnet-specific config inputs for
// `new WalrusClient(...)`. Returns the `packageConfig` from the
// walrus package's `captured.systemObject` / `captured.stakingObject`
// (populated by the `Walrus({...})` plugin's register step) plus
// `storageNodeUrlScheme: 'http'` — devstack storage nodes serve plain
// HTTP.
//
// Apps consume both helpers from `@mysten-incubation/devstack/browser`:
//
//     import { captured } from './generated/captured.js';
//     import {
//       getWalrusCaptured,
//       localnetWalrusOptions,
//     } from '@mysten-incubation/devstack/browser';
//     const ids = getWalrusCaptured(captured);
//     const opts = localnetWalrusOptions(ids);
//
// `getWalrusCaptured` centralises the `Record<string, …>` cast + the
// "walrus not deployed yet" error message so every example app reads
// off the same typed shape (audit finding E66).

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

// Shape of the walrus entry inside the codegen-generated `captured.ts`
// barrel. The `Walrus({...})` plugin's register step writes
// `{ systemObject, stakingObject }` under the `'walrus.walrus'` key.
// Both fields are optional in the source shape (the entry doesn't exist
// until the deploy completes); `getWalrusCaptured` narrows to the
// required-fields shape.
interface WalrusCapturedEntry {
	systemObject?: string;
	stakingObject?: string;
}

/**
 * Read the walrus ids off the codegen-generated `captured` barrel,
 * with a typed error when walrus hasn't finished deploying yet.
 *
 * Apps that compose a `Walrus({...})` tag get a per-package `captured`
 * export under `'walrus.walrus'` populated by the plugin's register
 * step. This helper centralises the `Record<string, …>` cast and the
 * "walrus not deployed yet" guard so every consumer reads off the same
 * shape (audit finding E66).
 *
 * The returned object plugs directly into `localnetWalrusOptions`:
 *
 * ```ts
 * import { captured } from './generated/captured.js';
 * import {
 *   getWalrusCaptured,
 *   localnetWalrusOptions,
 * } from '@mysten-incubation/devstack/browser';
 *
 * const opts = localnetWalrusOptions(getWalrusCaptured(captured));
 * ```
 *
 * Throws `Error` (not a tagged effect-error) so this stays usable from
 * non-Effect browser code without forcing every consumer to import the
 * Effect runtime.
 */
export function getWalrusCaptured(
	captured: Record<string, unknown>,
	options?: {
		/** Optional walrus tag key — defaults to `'walrus.walrus'`. Pass
		 *  when the `Walrus({name: ...})` was named explicitly so the
		 *  `captured` entry lives under a non-default key. */
		readonly key?: string;
	},
): LocalnetWalrusInputs {
	const key = options?.key ?? 'walrus.walrus';
	const entry = (captured as Record<string, WalrusCapturedEntry | undefined>)[key];
	if (
		entry === undefined ||
		entry.systemObject === undefined ||
		entry.stakingObject === undefined
	) {
		throw new Error(
			`walrus not deployed yet — \`captured[${JSON.stringify(key)}]\` is missing systemObject/stakingObject. ` +
				`Has the supervisor finished bringing walrus up?`,
		);
	}
	return {
		systemObjectId: entry.systemObject,
		stakingPoolId: entry.stakingObject,
	};
}
