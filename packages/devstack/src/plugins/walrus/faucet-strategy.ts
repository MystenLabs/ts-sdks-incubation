// Walrus WAL faucet strategy.
//
// Distilled-doc reference (06-walrus.md §"Lifecycle phase 7a"):
// when the local cluster has a non-empty `exchange`, walrus registers
// a WAL exchange strategy on the global strategy registry so any
// `account('alice', { funding: [{ coin: wal, amount }] })` request
// gets satisfied via SUI → WAL swap on chain.
//
// Architecture (StrategyContributor §7): the faucet registry is
// `capabilityKey: 'coinType:<fullCoinType>'` (distilled-doc
// convention shared with the faucet plugin's domain:discriminator
// pattern). The dispatch site doesn't import this strategy — it
// looks it up by key.
//
import { Effect, Schema } from 'effect';

import type { ChainProbe } from '../../contracts/chain-probe.ts';
import type { StrategyContributorDecl } from '../../contracts/strategy-contributor.ts';
import type { AccountFundingStrategy } from '../account/index.ts';
import { walrusPluginError, type WalrusPluginError } from './errors.ts';
import type { WalExchangeProbeKey } from './wal-swap.ts';
import { swapAccountSuiForWal, type WalExchangeHandle, type WalSwapSdk } from './wal-swap.ts';

/** Full local WAL coin type derived from the deployed Walrus package. */
export const walCoinType = <PackageId extends string>(
	packageId: PackageId,
): `${PackageId}::wal::WAL` => `${packageId}::wal::WAL` as const;

/** Resolve the package id that defines `wal::WAL`.
 *
 *  The Walrus deploy summary's `package_id` can be the latest upgraded
 *  Walrus package, while Sui coin types use the original package id
 *  that defines `wal::WAL`. The protected treasury object is the
 *  reliable on-chain anchor for that original id. */
export const parseWalCoinTypeFromTreasuryType = (
	treasuryType: string,
): `${string}::wal::WAL` | null => {
	const protectedTreasury = /^(0x[0-9a-fA-F]+)::wal::ProtectedTreasury$/.exec(treasuryType);
	if (protectedTreasury?.[1] !== undefined) {
		return walCoinType(protectedTreasury[1]);
	}

	const treasuryCap = /^0x(?:0+)?2::coin::TreasuryCap<((0x[0-9a-fA-F]+)::wal::WAL)>$/.exec(
		treasuryType,
	);
	if (treasuryCap?.[1] !== undefined) {
		return treasuryCap[1] as `${string}::wal::WAL`;
	}

	return null;
};

export const walPackageIdFromCoinType = (fullCoinType: `${string}::wal::WAL`): string =>
	fullCoinType.split('::')[0]!;

const WalTreasuryObjectShape = Schema.Struct({
	objectId: Schema.String,
	type: Schema.String,
});

export const resolveWalCoinType = (args: {
	readonly probe: ChainProbe<WalExchangeProbeKey>;
	readonly treasuryObjectId: string | undefined;
	readonly deployPackageId: string;
	readonly requireTreasuryObject: boolean;
}): Effect.Effect<`${string}::wal::WAL`, WalrusPluginError> =>
	Effect.gen(function* () {
		if (args.treasuryObjectId === undefined) {
			if (!args.requireTreasuryObject) return walCoinType(args.deployPackageId);
			return yield* Effect.fail(
				walrusPluginError(
					'exchange',
					'walrus.exchange: WAL exchange funding requires treasury_object in walrus deploy output so the original WAL coin type can be resolved.',
				),
			);
		}

		const found = yield* args.probe
			.get({ kind: 'object', objectId: args.treasuryObjectId }, WalTreasuryObjectShape, 'lenient')
			.pipe(
				Effect.mapError((cause) =>
					walrusPluginError(
						'exchange',
						`walrus.exchange: failed to resolve WAL treasury object ${args.treasuryObjectId}: ${cause.reason}: ${cause.detail}`,
						{ cause },
					),
				),
			);

		if (found === null) {
			if (!args.requireTreasuryObject) return walCoinType(args.deployPackageId);
			return yield* Effect.fail(
				walrusPluginError(
					'exchange',
					`walrus.exchange: WAL treasury object ${args.treasuryObjectId} was not found; cannot derive the WAL coin type for account funding.`,
				),
			);
		}

		const parsed = parseWalCoinTypeFromTreasuryType(found.type);
		if (parsed !== null) return parsed;

		return yield* Effect.fail(
			walrusPluginError(
				'exchange',
				`walrus.exchange: unexpected WAL treasury object type "${found.type}" — expected "<pkg>::wal::ProtectedTreasury" or "0x2::coin::TreasuryCap<<pkg>::wal::WAL>".`,
			),
		);
	});

/** Capability key for the WAL faucet strategy. */
export const walFaucetStrategyKey = <FullCoinType extends string>(
	fullCoinType: FullCoinType,
): `coinType:${FullCoinType}` => `coinType:${fullCoinType}` as const;

/** The WAL faucet strategy-contributor decl, keyed by the resolved WAL
 *  full coin type. Emitted inline from the local-mode walrus `start` (only
 *  when both a faucet strategy and a coin type resolved). Kept here next to
 *  the strategy + key so the contribution shape lives with its content.
 *
 *  `fullCoinType` is a plain `string` because the resolved value's
 *  `walCoinType` carries that width — `walFaucetStrategyKey` is generic and
 *  stamps it into the `coinType:` key verbatim. */
export const makeWalFaucetContribution = (
	strategy: WalFaucetStrategy,
	fullCoinType: string,
): StrategyContributorDecl<`coinType:${string}`, WalFaucetStrategy> => ({
	kind: 'strategy-contributor',
	capabilityKey: walFaucetStrategyKey(fullCoinType),
	strategy,
	autoMounted: true,
});

/** Faucet strategy value — closed over the WAL exchange's object id.
 *  The requesting account signs the swap through the shared account
 *  funding pipeline. */
export type WalFaucetStrategy = AccountFundingStrategy<WalrusPluginError>;

/** Inputs the local-cluster mode passes when constructing this. */
export interface WalFaucetStrategyOptions {
	readonly exchange: WalExchangeHandle;
	readonly sdk: WalSwapSdk;
}

/** Build the strategy value.
 *
 *  The request amount is the SUI MIST amount to spend on the local
 *  exchange for WAL. Account funding skips zero amounts before the
 *  strategy is invoked; the guard here keeps direct calls no-op. */
export const makeWalFaucetStrategy = (opts: WalFaucetStrategyOptions): WalFaucetStrategy => ({
	usesAccountSigner: true,
	// The swap buys WAL with the recipient account's own SUI, so the recipient
	// must be a resolved account with a signer — funding an arbitrary 0x address
	// is rejected by the dispatcher/dashboard on this flag.
	requiresRecipientAccount: true,
	request: (req) => {
		if (req.amount <= 0n) return Effect.void;
		if (req.account === undefined) {
			return Effect.fail(
				walrusPluginError(
					'fund-wal',
					'walrus WAL funding spends the recipient account’s own SUI, so it requires a resolved account signer.',
				),
			);
		}
		return swapAccountSuiForWal({
			account: req.account,
			sdk: opts.sdk,
			exchange: opts.exchange,
			recipientAddress: req.address,
			paymentMist: req.amount,
		}).pipe(Effect.asVoid);
	},
});
