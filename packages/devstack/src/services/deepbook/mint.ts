// DeepBook DEEP/USDC mint sugar — wraps `mintFromTreasury` with deepbook-
// specific TreasuryCap references. The local-deploy publish captures
// `deepTreasuryId` from objectChanges (TreasuryCap<{pkg}::deep::DEEP>);
// `DeepbookMintDEEP` reads it via `captured.deepTreasuryId`. USDC's
// TreasuryCap originates from a caller-published USDC Move package and
// is supplied directly.

/* eslint-disable @typescript-eslint/no-explicit-any */

import type { LayeredTag } from '../../advanced/tag.js';
import { mintFromTreasury } from '../coin.js';
import type { Account } from '../../engine/shared.js';

export interface DeepbookMintDEEPOptions<Name extends string> {
	readonly name?: Name;
	readonly signer: LayeredTag<any, Account, any, any>;
	/** The deepbook deploy tag — must expose `captured.deepTreasuryId`
	 *  (set by `deepbookLocalDeploy`'s publish capture callback) and
	 *  `packageId` so the full coin type can be derived. */
	readonly deepbook: LayeredTag<
		any,
		{
			readonly packageId: string;
			readonly captured?: Record<string, unknown>;
		},
		any,
		any
	>;
	readonly to: string;
	readonly amount: bigint;
	readonly gasBudget?: bigint;
}

/**
 * Mint DEEP from the local-deploy's TreasuryCap to a recipient. Reads the
 * cap id from the deepbook tag's `captured.deepTreasuryId` and derives
 * the DEEP coin type as `<packageId>::deep::DEEP`.
 */
export const DeepbookMintDEEP = <const Name extends string = 'mintDEEP'>(
	opts: DeepbookMintDEEPOptions<Name>,
) =>
	mintFromTreasury({
		name: (opts.name ?? 'mintDEEP') as Name,
		signer: opts.signer,
		treasuryCap: {
			fromPackage: opts.deepbook as unknown as LayeredTag<
				any,
				{ readonly captured?: Record<string, unknown> },
				any,
				any
			>,
			capturedField: 'deepTreasuryId',
		},
		coinType: {
			fromPackage: opts.deepbook as unknown as LayeredTag<
				any,
				{ readonly packageId: string },
				any,
				any
			>,
			module: 'deep',
			type: 'DEEP',
		},
		to: opts.to,
		amount: opts.amount,
		...(opts.gasBudget !== undefined ? { gasBudget: opts.gasBudget } : {}),
		dependsOn: [opts.deepbook],
	});

export interface DeepbookMintUSDCOptions<Name extends string> {
	readonly name?: Name;
	readonly signer: LayeredTag<any, Account, any, any>;
	/** USDC TreasuryCap id (caller publishes the USDC Move package and
	 *  passes the captured cap id directly). */
	readonly treasuryCap: string;
	/** Fully-qualified USDC coin type
	 *  (e.g. `0xpkg::usdc::USDC`). */
	readonly coinType: string;
	readonly to: string;
	readonly amount: bigint;
	readonly gasBudget?: bigint;
	readonly dependsOn?: ReadonlyArray<LayeredTag<any, any, any, any>>;
}

/**
 * Mint USDC from a caller-supplied TreasuryCap. Generic wrapper over
 * `mintFromTreasury` — the sugar is in the option shape (`treasuryCap`
 * + `coinType` are required strings; consumers don't need to wire up a
 * package-ref form for a stable USDC publish that's already known by
 * id).
 */
export const DeepbookMintUSDC = <const Name extends string = 'mintUSDC'>(
	opts: DeepbookMintUSDCOptions<Name>,
) =>
	mintFromTreasury({
		name: (opts.name ?? 'mintUSDC') as Name,
		signer: opts.signer,
		treasuryCap: opts.treasuryCap,
		coinType: opts.coinType,
		to: opts.to,
		amount: opts.amount,
		...(opts.gasBudget !== undefined ? { gasBudget: opts.gasBudget } : {}),
		...(opts.dependsOn !== undefined ? { dependsOn: opts.dependsOn } : {}),
	});
