// `mintCoinDistribution()` — sugar over `seed()` for the canonical
// "mint N coins, distribute among M accounts" pattern. Wallet/swap/
// lending demo apps all duplicate the same shape:
//
//   - find the published mock-coin package by registry name,
//   - look up its `treasuryCapId` from `captured`,
//   - build one tx with one `mint` moveCall per recipient,
//   - sign as the publisher, wait for the tx.
//
// The wallet example's `seedTokens` was 78 lines of this — collapses
// to ~10 here. The helper handles only the common case (localnet
// publisher signs the mint); custom seeds (vesting schedules,
// permissioned mints) drop into raw `seed()`.

import { Transaction } from '@mysten/sui/transactions';

import type { Provides, SeedAction } from '../core/types.js';
import { openSuiRpcClient } from '../helpers/sui-client.js';
import { seed } from './seed.js';

export interface CoinDistributionEntry {
	/** Account name registered in `DevstackConfig.accounts`. */
	recipient: string;
	/** Mint amount in raw units (i.e. with the coin's decimals already
	 * applied). */
	amount: bigint;
}

export interface CoinDistributionSpec {
	/** Registry name of the published Move package (matches
	 * `publishMove({ name })` or `registryAs:`). */
	package: string;
	/** Move module name. Conventional value matches the package name
	 * (e.g. `mock_usdc::mock_usdc::mint`). */
	module: string;
	/** Mint function name. Default `'mint'`. */
	mintFunction?: string;
	/** Per-recipient amounts. */
	distribution: ReadonlyArray<CoinDistributionEntry>;
}

export interface MintCoinDistributionOptions {
	name: string;
	needs?: string[];
	provides?: Provides;
	/** Account name that signs the mint tx. Defaults to `'publisher'`. */
	signer?: string;
	/** Per-coin distributions. The action mints all coins in one tx so
	 * it counts as a single action against the same-signer serializer. */
	distributions: ReadonlyArray<CoinDistributionSpec>;
	/** Maximum gas budget for the combined mint tx. Default 500_000_000
	 * MIST (0.5 SUI) — enough for ~50 mint moveCalls. */
	gasBudget?: bigint;
}

const DEFAULT_GAS_BUDGET = 500_000_000n;

export function mintCoinDistribution(
	opts: MintCoinDistributionOptions,
): SeedAction<Record<string, unknown>> {
	const signerName = opts.signer ?? 'publisher';
	const gasBudget = opts.gasBudget ?? DEFAULT_GAS_BUDGET;

	// Inputs are the structural identity of the action — recipients +
	// amounts + the package binding. Bigints serialize via toString so
	// stableHash treats them deterministically.
	const inputs = {
		signer: signerName,
		gasBudget: gasBudget.toString(),
		distributions: opts.distributions.map((d) => ({
			package: d.package,
			module: d.module,
			mintFunction: d.mintFunction ?? 'mint',
			distribution: d.distribution.map((e) => ({
				recipient: e.recipient,
				amount: e.amount.toString(),
			})),
		})),
	};

	return seed({
		name: opts.name,
		needs: opts.needs,
		provides: opts.provides,
		runsAs: signerName,
		inputs,
		run: async (ctx) => {
			const signer = ctx.accounts.get(signerName);
			const client = openSuiRpcClient(ctx);
			const tx = new Transaction();
			tx.setGasBudget(gasBudget);
			for (const spec of opts.distributions) {
				const pkg = ctx.registry.packages.require(spec.package);
				const treasuryCapId = pkg.captured.treasuryCapId;
				if (treasuryCapId === undefined) {
					throw new Error(
						`mintCoinDistribution: package '${spec.package}' has no captured ` +
							"`treasuryCapId`. Add `capture: { treasuryCapId: '::coin::TreasuryCap<' }` " +
							'to its publishMove call so the cap is discoverable.',
					);
				}
				const target = `${pkg.packageId}::${spec.module}::${spec.mintFunction ?? 'mint'}`;
				for (const entry of spec.distribution) {
					const recipient = ctx.registry.accounts.require(entry.recipient).address;
					tx.moveCall({
						target,
						arguments: [
							tx.object(treasuryCapId),
							tx.pure.u64(entry.amount),
							tx.pure.address(recipient),
						],
					});
				}
			}
			const result = await client.signAndExecuteTransaction({
				signer,
				transaction: tx,
				options: { showEffects: true },
			});
			const status = result.effects?.status?.status;
			if (status !== 'success') {
				const err = result.effects?.status?.error ?? 'unknown';
				throw new Error(`mintCoinDistribution(${opts.name}): tx failed: ${err}`);
			}
			await client.waitForTransaction({ digest: result.digest });
		},
	});
}
