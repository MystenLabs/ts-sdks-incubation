// Faucet dispatcher.
//
// Architecture (distilled doc §Selection rule): dispatch by
// capability key ONLY. The user's network mode (local vs testnet vs
// mainnet vs fork) does NOT branch at dispatch time — mode shapes
// the POPULATION of the registry; the dispatcher itself is mode-
// agnostic.
//
// Capability key shape: `faucet:request:<chainId>`. The chain id is
// the substrate-level `NetworkConfig.chain` value (e.g. `'sui:localnet'`,
// `'sui:testnet'`, `'sui:mainnet-fork@123'`). Future per-coin
// dispatch (WAL exchange, treasury-cap-mint) extends this with a
// `:<coinType>` suffix; today the dispatcher only handles the
// SUI-side coin flow. (Open question in the distilled doc §Open
// questions #3.)

import { Effect } from 'effect';

import type { StrategyRegistry } from '../../contracts/strategy-contributor.ts';
import { faucetStrategyMissing } from './errors.ts';
import type {
	FaucetBodyError,
	FaucetExhausted,
	FaucetStrategyMissing,
	FaucetUnreachable,
} from './errors.ts';
import type { FaucetStrategy } from './strategies/sui-local.ts';

/** Capability key prefix for a faucet request strategy. The full
 *  key is `faucet:request:<chainId>`. */
export const FAUCET_CAPABILITY_KEY_PREFIX = 'faucet:request' as const;

/** Build the full capability key for a chain. Literal-typed so the
 *  downstream `StrategyFor<Caps, Key>` lookup picks the strategy
 *  shape out of a tuple by name. */
export const faucetCapabilityKey = <ChainId extends string>(
	chainId: ChainId,
): `${typeof FAUCET_CAPABILITY_KEY_PREFIX}:${ChainId}` =>
	`${FAUCET_CAPABILITY_KEY_PREFIX}:${chainId}` as const;

/** A single funding request. */
export interface FaucetRequest {
	/** Chain id (`'sui:localnet'`, `'sui:testnet'`, etc.). Selects
	 *  the strategy via capability-key lookup. */
	readonly chainId: string;
	/** Destination address. */
	readonly address: string;
	/** Amount in the chain-native smallest unit (MIST for sui). The
	 *  SUI HTTP faucet binary itself ignores `amount` and grants a
	 *  fixed value per request; the field is the dispatcher-level
	 *  unit and carries through to error payloads. */
	readonly amount: bigint;
}

/** Dispatcher view exposed by the plugin's resolved value. */
export interface FaucetDispatcher {
	/** Dispatch a funding request to the matching strategy. */
	readonly request: (
		req: FaucetRequest,
	) => Effect.Effect<
		void,
		FaucetStrategyMissing | FaucetUnreachable | FaucetBodyError | FaucetExhausted
	>;
	/** List the capability keys currently registered for faucet
	 *  requests. Used by surfaces that want to render "what chains
	 *  can this stack hand out coins to right now." */
	readonly listFundableChains: Effect.Effect<ReadonlyArray<string>>;
}

/** Build a dispatcher closure over the substrate's
 *  `StrategyRegistry`. The dispatcher is created at the plugin's
 *  acquire and stored on the resolved value. */
export const makeDispatcher = (registry: StrategyRegistry): FaucetDispatcher => ({
	request: (req) =>
		Effect.gen(function* () {
			const key = faucetCapabilityKey(req.chainId);
			// Convert the substrate-level `StrategyNotFoundError` into
			// the faucet-flavored `FaucetStrategyMissing` (carries
			// amount + address) at the plugin boundary.
			const strategy = yield* registry.get<typeof key, FaucetStrategy>(key).pipe(
				Effect.catchTag('StrategyNotFoundError', (err) =>
					Effect.fail(
						faucetStrategyMissing({
							capabilityKey: key,
							address: req.address,
							amount: req.amount,
							registeredKeys: err.registeredKeys,
							hint:
								`no faucet strategy registered for '${req.chainId}'. ` +
								`Registered keys: [${err.registeredKeys.join(', ')}]. ` +
								`Check that the corresponding sui() plugin is in the stack ` +
								`AND its mode has a faucet (mainnet has none).`,
						}),
					),
				),
			);
			yield* strategy.request({ address: req.address, amount: req.amount });
		}).pipe(
			Effect.withSpan('faucet.dispatch', {
				attributes: {
					'faucet.chainId': req.chainId,
					'faucet.address': req.address,
					'faucet.amount': req.amount.toString(),
				},
			}),
		),

	listFundableChains: Effect.gen(function* () {
		const keys = yield* registry.list();
		// Surface only the chain ids — strip the capability prefix.
		return keys
			.filter((k) => k.startsWith(`${FAUCET_CAPABILITY_KEY_PREFIX}:`))
			.map((k) => k.slice(FAUCET_CAPABILITY_KEY_PREFIX.length + 1));
	}),
});
