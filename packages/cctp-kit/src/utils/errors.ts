// Copyright (c) Mysten Labs, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { ChainDefinition } from '../chains/types.js';

/**
 * A transaction that definitely did not take effect: it was mined and reverted, or it can no
 * longer land. Nothing moved, so sending it again is safe.
 *
 * Anything else that goes wrong while waiting for a transaction (a timeout, an RPC outage) is
 * NOT this error: the transaction may still have gone through, and must not be sent again.
 */
export class TransactionRevertedError extends Error {
	override name = 'TransactionRevertedError';
}

/**
 * The wallet is on another network and did not move when asked. Nothing was sent, so switching
 * it by hand and trying again is safe.
 */
export class WalletNetworkError extends Error {
	override name = 'WalletNetworkError';
}

/** The coin that pays for transactions on a chain. */
function gasCoin(chain: ChainDefinition): string {
	switch (chain.ecosystem) {
		case 'evm':
			return chain.viemChain.nativeCurrency.symbol;
		case 'sui':
			return 'SUI';
		case 'solana':
			return 'SOL';
	}
}

/** What to tell someone whose wallet cannot pay for a transaction on `chain`. */
export function gasShortfallMessage(chain?: ChainDefinition): string {
	if (!chain) return 'The wallet does not have enough of the network coin to pay for gas.';
	const coin = gasCoin(chain);
	return `The wallet does not have enough ${coin} on ${chain.name} to pay for gas. Add some ${coin} on ${chain.name}, then try again.`;
}

interface ErrorLink {
	name?: string;
	message: string;
	code?: unknown;
	shortMessage?: unknown;
	details?: unknown;
}

/** An error and everything it was caused by, outermost first. */
function causes(error: unknown): ErrorLink[] {
	const links: ErrorLink[] = [];
	for (let at = error; at instanceof Error && links.length < 10; at = at.cause) {
		links.push(at as ErrorLink);
	}
	return links;
}

// How nodes and wallets say the sender cannot cover the fee. On EVM "insufficient funds" is
// always about the native coin; a token that is short reverts in the token's own words.
const NO_GAS = [
	/insufficient funds/i,
	/gas required exceeds allowance/i,
	/exceeds the balance of the account/i,
	/found no record of a prior credit/i, // Solana: the fee payer holds no SOL
	/insufficient (funds|lamports) for fee/i,
	/no valid gas coins/i, // Sui
	/gasbalancetoolow|insufficientgas/i,
];
const REJECTED =
	/user (rejected|denied|cancell?ed|declined|disapproved)|(rejected|cancell?ed|denied) (by|from) (the )?user|user rejection/i;
const MAX_LENGTH = 300;

/** One line, without the stretches of hex a wallet library prints its arguments as. */
function tidy(text: string): string {
	const line = text
		.replace(/0x[0-9a-fA-F]{65,}/g, (hex) => `${hex.slice(0, 10)}…${hex.slice(-6)}`)
		.replace(/\s+/g, ' ')
		.trim();
	return line.length > MAX_LENGTH ? `${line.slice(0, MAX_LENGTH - 1)}…` : line;
}

/**
 * Put an error into words for the person waiting on a transfer.
 *
 * Wallet libraries write their errors for developers: the call, its arguments, a link to the
 * docs, a version. A claim that failed because the wallet had no gas came out as forty lines of
 * hex. This names the few failures someone can act on, and otherwise keeps to the library's own
 * one-line summary. `chain` is where the failing step ran, when that is known.
 */
export function describeError(error: unknown, context: { chain?: ChainDefinition } = {}): string {
	if (!(error instanceof Error)) return tidy(String(error));
	// The kit's own errors are already written for the person reading them. What caused one is
	// kept for whoever debugs it, and is not a second opinion on what to say.
	if (error instanceof WalletNetworkError || error instanceof TransactionRevertedError) {
		return tidy(error.message);
	}
	const links = causes(error);
	const said = links.map((link) => link.message).join('\n');
	if (
		links.some((link) => link.name === 'InsufficientFundsError') ||
		NO_GAS.some((r) => r.test(said))
	) {
		return gasShortfallMessage(context.chain);
	}
	const refusal = links.find(
		(link) => link.name === 'UserRejectedRequestError' || link.code === 4001,
	);
	if (refusal) {
		// Libraries also file other refusals under "rejected by the user", such as a wallet with
		// no method for what was asked. Only say the user did it when the wallet's own words,
		// which the library keeps as `details`, say so.
		const words =
			typeof refusal.details === 'string' && refusal.details
				? refusal.details
				: links[links.length - 1]!.message;
		return REJECTED.test(words)
			? 'The request was rejected in the wallet.'
			: `The wallet turned the request down: ${tidy(words)}`;
	}
	if (REJECTED.test(said)) return 'The request was rejected in the wallet.';
	const summary = links.map((link) => link.shortMessage).find((s) => typeof s === 'string' && s);
	return tidy(typeof summary === 'string' ? summary : error.message);
}
