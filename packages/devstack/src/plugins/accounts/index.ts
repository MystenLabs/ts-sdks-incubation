// `accounts()` plugin — funds the named accounts declared in
// `DevstackConfig.accounts` against a running localnet, then registers
// them in `ctx.registry.accounts` for downstream actions to consume.
//
// Single Register action (`accounts.fund`):
//
//   - `getStatus`: pure read-only probe. Hits the registered sui-rpc +
//     sui-faucet services to read each account's total balance + AB
//     accumulator and compares against targets. No chain mutation.
//   - `run`: faucets each account up to `minBalance`, then signs an
//     AB-deposit tx per account so the address-balance accumulator has
//     something for AB-gas mode to draw from. Idempotent.
//   - `provides.registry`: re-publishes the accounts into
//     `ctx.registry.accounts` on warm-path skips so downstream actions
//     see them without re-running.
//
// Reads the rpc + faucet URLs from `ctx.registry.services` (registered
// by the sui plugin's localnet action). Decoupled from the sui plugin's
// internal port-allocation: the accounts plugin doesn't allocate any
// ports, doesn't manage any containers — it just talks to the running
// chain.
//
// Live-net targets (testnet/mainnet) skip this plugin via the
// `applyFilter` (which strips every Service action and the actions they
// need). On those networks accounts are pre-existing;
// users supply their own factories via `accounts: { publisher: { mainnet:
// cliSigner({...}) } }`.

import { register } from '../../actions/register.js';
import type { Plugin } from '../../core/types.js';
import { definePlugin } from '../../plugin.js';
import { probeUrl } from '../../helpers/probe.js';
import {
	AB_TOLERANCE_MIST,
	COIN_RESERVE_MIST,
	DEFAULT_MIN_BALANCE,
	ensureAddressBalance,
	ensureFunded,
	fetchAddressBalance,
	fetchBalance,
} from '../sui/keys.js';

export interface AccountsPluginOptions {
	/** Per-account minimum total balance in MIST. Default 50 SUI.
	 * `accounts.fund` faucets up to this and pushes most of it into the
	 * address-balance accumulator; the remainder stays as a single coin
	 * object for legacy `tx.gas` flows. */
	minBalance?: bigint;
	/** Names of actions that must run before `accounts.fund`. Defaults
	 * to `['sui.localnet']` so the chain + RPC + faucet are up.
	 * Override for non-sui chain plugins (none today). */
	needs?: string[];
}

export const accounts = (opts: AccountsPluginOptions = {}): Plugin<'accounts.fund'> => {
	const minBalance = opts.minBalance;
	const needs = opts.needs ?? ['sui.localnet'];

	return definePlugin({
		name: 'accounts',
		// Snapshot-id input: only `minBalance` matters for re-funding
		// decisions. The list of account names comes from
		// `DevstackConfig.accounts` and lives in the `accounts` field of
		// the snapshot id, not here.
		inputs: { minBalance: minBalance?.toString() },
		provides: ['accounts.fund'],
		actions: () => [
			register({
				name: 'fund',
				needs,
				// Live-net targets supply pre-funded accounts via per-network
				// signer factories; faucet + AB-deposit logic only makes
				// sense against a localnet sui-faucet. Filtering at the
				// network-allowlist layer keeps the action graph honest
				// instead of relying on cli/filters.ts to drop arbitrary
				// Register actions by type.
				networks: ['localnet'],
				provides: {
					// Reconciler invokes this on every successful path (cold run +
					// warm-path skip), so the in-memory accounts registry is
					// populated regardless of whether `run` executed this cycle.
					// Only reached when `getStatus.ok` (every account funded) so
					// the addresses we re-publish here are known-good.
					registry: (ctx) => {
						for (const name of ctx.accounts.names()) {
							const signer = ctx.accounts.get(name);
							ctx.registry.accounts.register({
								name,
								address: signer.toSuiAddress(),
								role: name === 'publisher' ? 'publisher' : undefined,
								funded: true,
							});
						}
					},
				},
				inputs: {
					minBalance: minBalance?.toString(),
				},
				getStatus: async (ctx) => {
					// Pure read-only probe: hit the rpc + faucet (registered by
					// the sui plugin) and compare each account's balances to the
					// configured target. `run` does the actual faucet + deposit
					// work — keeping this function side-effect-free preserves the
					// reconciler's "is it already done?" semantic.
					const names = ctx.accounts.names();
					if (names.length === 0) return { ok: true, detail: 'no accounts declared' };
					const rpcService = ctx.registry.services.find('sui-rpc');
					const faucetService = ctx.registry.services.find('sui-faucet');
					if (rpcService === undefined) {
						return { ok: false, detail: 'sui-rpc not registered (sui.localnet not up?)' };
					}
					if (faucetService === undefined) {
						return { ok: false, detail: 'sui-faucet not registered (sui.localnet not up?)' };
					}
					const rpcUrl = rpcService.url;
					const faucetReachable = await probeUrl(faucetService.url, {
						accept: (r) => r.status < 500,
					});
					if (!faucetReachable) {
						return { ok: false, detail: `faucet ${faucetService.url} unreachable` };
					}
					const minBal = minBalance ?? DEFAULT_MIN_BALANCE;
					const abTarget = minBal - COIN_RESERVE_MIST;
					for (const name of names) {
						let address: string;
						try {
							address = ctx.accounts.get(name).toSuiAddress();
						} catch (err) {
							return {
								ok: false,
								detail: `account '${name}' resolve: ${err instanceof Error ? err.message : 'failed'}`,
							};
						}
						let balance: bigint;
						let ab: bigint;
						try {
							balance = await fetchBalance(rpcUrl, address);
							ab = await fetchAddressBalance(rpcUrl, address);
						} catch (err) {
							return {
								ok: false,
								detail: `account '${name}' probe: ${err instanceof Error ? err.message : 'rpc unreachable'}`,
							};
						}
						if (balance < minBal) {
							return {
								ok: false,
								detail: `account '${name}' total balance ${balance} below ${minBal} MIST`,
							};
						}
						// Match the tolerance band in `ensureAddressBalance`: AB
						// lands a few MIST under target after fees, and we don't
						// want every cycle to re-trigger a deposit.
						if (abTarget > 0n && ab + AB_TOLERANCE_MIST < abTarget) {
							return {
								ok: false,
								detail: `account '${name}' address-balance ${ab} below ${abTarget} MIST`,
							};
						}
					}
					return { ok: true, detail: `${names.length} account(s) funded` };
				},
				run: async (ctx) => {
					const rpcUrl = ctx.registry.services.require('sui-rpc').url;
					const faucetUrl = ctx.registry.services.require('sui-faucet').url;
					for (const name of ctx.accounts.names()) {
						const signer = ctx.accounts.get(name);
						const address = signer.toSuiAddress();
						await ensureFunded({ faucetUrl, rpcUrl, address, minBalance });
						// After the faucet seeds a single coin, deposit most of it
						// into the address-balance accumulator so AB-gas txs have
						// something to draw from. Idempotent on warm cycles.
						await ensureAddressBalance({ rpcUrl, signer });
					}
				},
			}),
		],
	});
};

