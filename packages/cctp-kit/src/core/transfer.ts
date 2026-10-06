// Copyright (c) Mysten Labs, Inc.
// SPDX-License-Identifier: Apache-2.0

import { PublicKey } from '@solana/web3.js';
import type {
	ChainDefinition,
	EvmChainDefinition,
	SolanaChainDefinition,
	SuiChainDefinition,
} from '../chains/types.js';
import {
	approveEvmUsdc,
	evmDepositForBurn,
	evmIsNonceUsed,
	evmReceiveMessage,
	getEvmUsdcAllowance,
	getEvmUsdcBalance,
	waitForEvmReceipt,
} from '../engine/evm.js';
import {
	buildSolanaBurnTransaction,
	buildSolanaReceiveTransaction,
	buildSolanaTokenAccountTransaction,
	getAssociatedTokenAddress,
	getSolanaClaimFunds,
	getSolanaConnection,
	getSolanaUsdcBalance,
	hasSolanaTransactionSucceeded,
	solanaIsNonceUsed,
	waitForSolanaConfirmation,
} from '../engine/solana.js';
import {
	buildSuiBurnTransaction,
	buildSuiReceiveTransaction,
	getSuiUsdcBalance,
} from '../engine/sui.js';
import type { IrisClient } from '../iris/client.js';
import { formatUsdc } from '../utils/amount.js';
import { bytesToHex, hexToBytes, parseMessageV2, toBytes32 } from '../utils/bytes.js';
import type { Hex } from '../utils/bytes.js';
import { TransactionRevertedError } from '../utils/errors.js';
import type { WalletAdapters } from '../wallets/types.js';
import type { AnyDAppKit, TransferRecord } from './types.js';

export interface TransferContext {
	dAppKit: AnyDAppKit;
	wallets: () => Promise<WalletAdapters>;
	iris: IrisClient;
	chains: ChainDefinition[];
	signal?: AbortSignal;
	/**
	 * Stop once the attestation is in hand (status `readyToMint`) instead of minting. Used when
	 * resuming automatically after a reload, since the mint needs the user's wallet.
	 */
	stopAfterAttestation?: boolean;
	/** Skip the destination "nonce already used" lookup (defaults to true; tests disable it). */
	checkNonce?: boolean;
	/** Attestation polling interval (defaults to 5 s). */
	pollIntervalMs?: number;
	/** Called after every state change; the caller persists and re-renders. */
	onUpdate: (transfer: TransferRecord) => void;
}

/**
 * Drives a transfer through approve → burn → attest → mint, resuming from whatever step the
 * record is at. Every step is idempotent with respect to the persisted record so a reload
 * mid-transfer can pick up where it left off.
 */
export async function runTransfer(
	record: TransferRecord,
	ctx: TransferContext,
): Promise<TransferRecord> {
	let transfer = { ...record };
	const update = (patch: Partial<TransferRecord>) => {
		transfer = { ...transfer, ...patch, updatedAt: Date.now() };
		ctx.onUpdate(transfer);
		return transfer;
	};

	const from = findChain(ctx.chains, transfer.from);
	const to = findChain(ctx.chains, transfer.to);

	try {
		if (!transfer.sourceTxHash) {
			const sourceTxHash = await burn(transfer, from, to, ctx, update);
			const burnedAt = Date.now();
			update({ status: 'attesting', sourceTxHash, burnedAt, attestingSince: burnedAt });
		} else if (
			transfer.status === 'pending' ||
			transfer.status === 'approving' ||
			transfer.status === 'burning'
		) {
			update({ status: 'attesting', attestingSince: transfer.attestingSince ?? Date.now() });
		}

		if (!transfer.attestation || !transfer.message) {
			ctx.signal?.throwIfAborted();
			if (transfer.status !== 'attesting' || !transfer.attestingSince) {
				update({ status: 'attesting', attestingSince: transfer.attestingSince ?? Date.now() });
			}
			const attested = await ctx.iris.waitForAttestation(from.domain, transfer.sourceTxHash!, {
				signal: ctx.signal,
				intervalMs: ctx.pollIntervalMs,
			});
			update({
				status: 'readyToMint',
				message: attested.message,
				attestation: attested.attestation,
			});
		} else if (transfer.status === 'attesting') {
			update({ status: 'readyToMint' });
		}

		if (!transfer.destinationTxHash) {
			ctx.signal?.throwIfAborted();
			// Resumed on load: stop at Claim without touching the destination chain; the nonce is
			// checked when the user actually claims.
			if (ctx.stopAfterAttestation) {
				if (transfer.status !== 'readyToMint') update({ status: 'readyToMint' });
				return transfer;
			}
			const nonceUsed =
				ctx.checkNonce === false ? false : await isNonceUsed(to, transfer.message!, ctx);
			if (nonceUsed) {
				update({ status: 'complete', completedAt: Date.now() });
				return transfer;
			}
			if (to.ecosystem === 'sui' && isExpiredOnSui(transfer.message!)) {
				update({ status: 'attesting' });
				await ctx.iris.reattest(bytesToHex(parseMessageV2(transfer.message!).nonce), ctx.signal);
				const fresh = await ctx.iris.waitForAttestation(from.domain, transfer.sourceTxHash!, {
					signal: ctx.signal,
					intervalMs: ctx.pollIntervalMs,
					differentFrom: transfer.attestation,
				});
				update({ message: fresh.message, attestation: fresh.attestation });
			}
			update({ status: 'minting' });
			const destinationTxHash = await mint(transfer, to, ctx);
			update({ status: 'complete', destinationTxHash, completedAt: Date.now() });
		} else {
			update({ status: 'complete', completedAt: transfer.completedAt ?? Date.now() });
		}
		return transfer;
	} catch (error) {
		if (ctx.signal?.aborted) throw error;
		update({ status: 'failed', error: errorMessage(error) });
		throw error;
	}
}

/**
 * A Fast Transfer message expires 24 hours after Circle signed it; the destination then
 * rejects it until Circle signs it again. Only a Sui destination can meet this here: Sui is a
 * standard-only source and standard messages carry no expiry. Sui reads the field as a
 * timestamp in milliseconds. A minute of margin covers the time it takes to sign and land.
 */
export function isExpiredOnSui(message: string, now = Date.now()): boolean {
	const expiry = parseMessageV2(message).body.expirationBlock;
	return expiry !== 0n && BigInt(now) + 60_000n >= expiry;
}

/**
 * Stop before an EVM or Solana wallet is asked when it plainly cannot pay. A wallet shown a
 * burn it cannot afford reports it in its own words ("not enough SOL" for missing USDC, in one
 * case), and a transfer that is retried may be looking at a balance from before its first
 * attempt. Not used for Sui: see the burn.
 */
async function assertSourceBalance(
	from: ChainDefinition,
	holder: string,
	amount: bigint,
	ctx: TransferContext,
) {
	let balance: bigint;
	try {
		switch (from.ecosystem) {
			case 'sui':
				balance = await getSuiUsdcBalance(ctx.dAppKit.getClient(from.suiNetwork), from, holder);
				break;
			case 'evm':
				balance = await getEvmUsdcBalance(from, holder as Hex);
				break;
			case 'solana':
				balance = await getSolanaUsdcBalance(from, new PublicKey(holder));
				break;
		}
	} catch {
		// The balance cannot be read: go ahead and let the wallet report what it finds.
		return;
	}
	if (balance < amount) {
		throw new Error(
			`Not enough USDC on ${from.name}: the wallet holds ${formatUsdc(balance)} and this transfer needs ${formatUsdc(amount)}.`,
		);
	}
}

async function burn(
	transfer: TransferRecord,
	from: ChainDefinition,
	to: ChainDefinition,
	ctx: TransferContext,
	update: (patch: Partial<TransferRecord>) => TransferRecord,
): Promise<string> {
	const amount = BigInt(transfer.amount);
	const maxFee = BigInt(transfer.maxFee);
	const minFinalityThreshold = transfer.speed === 'fast' ? 1000 : 2000;
	const mintRecipient = mintRecipientBytes(transfer.recipient, to);

	switch (from.ecosystem) {
		case 'sui': {
			// Nothing is awaited before the wallet is asked: a Sui wallet that signs in a window
			// it opens itself can only open it while the click is still being handled. The SDK
			// reports a short balance when it builds the transaction.
			update({ status: 'burning' });
			const tx = buildSuiBurnTransaction(from, {
				sender: transfer.sender,
				amount,
				destinationDomain: to.domain,
				mintRecipient,
				maxFee,
				minFinalityThreshold,
			});
			return executeSui(ctx, from, tx, (digest) => update({ sourceTxHash: digest }));
		}
		case 'evm': {
			const wallets = await ctx.wallets();
			const walletClient = await wallets.evm.getWalletClient(from);
			const owner = walletClient.account!.address;
			await assertSourceBalance(from, owner, amount, ctx);
			const allowance = await getEvmUsdcAllowance(from, owner);
			if (allowance < amount) {
				update({ status: 'approving' });
				await approveEvmUsdc(walletClient, from, amount);
			}
			update({ status: 'burning' });
			const hash = await evmDepositForBurn(walletClient, from, {
				amount,
				destinationDomain: to.domain,
				mintRecipient: bytesToHex(mintRecipient),
				maxFee,
				minFinalityThreshold,
			});
			update({ sourceTxHash: hash });
			try {
				// Sped up in the wallet, the burn is mined under another hash: that is the one
				// Circle knows.
				const mined = await waitForEvmReceipt(from, hash);
				if (mined !== hash) update({ sourceTxHash: mined });
				return mined;
			} catch (error) {
				if (error instanceof TransactionRevertedError) {
					// A reverted burn moved no funds; drop the hash so a retry burns again instead
					// of waiting on an attestation that will never come.
					update({ sourceTxHash: undefined });
					throw error;
				}
				// The receipt could not be read: a slow chain, an RPC outage, or viem's
				// three-minute limit. The burn may well be mined, so keep its hash and go on to
				// wait for Circle, which only ever attests a burn that happened. Forgetting the
				// hash here would make the next attempt burn a second time.
			}
			return hash;
		}
		case 'solana': {
			const wallets = await ctx.wallets();
			update({ status: 'burning' });
			const owner = new PublicKey(transfer.sender);
			const dropped = transfer.droppedSourceTxHash;
			if (dropped) {
				// An earlier burn was written off as expired. Look once more before burning again:
				// if it went through after all, it is this transfer's burn.
				const landed = await hasSolanaTransactionSucceeded(from, dropped);
				if (landed === null) {
					throw new Error(
						'Could not check whether the earlier burn went through. Try again in a moment.',
					);
				}
				if (landed) {
					update({ sourceTxHash: dropped, droppedSourceTxHash: undefined });
					return dropped;
				}
			}
			await assertSourceBalance(from, transfer.sender, amount, ctx);
			const built = await buildSolanaBurnTransaction(from, {
				owner,
				amount,
				destinationDomain: to.domain,
				mintRecipient,
				maxFee,
				minFinalityThreshold,
			});
			const signature = await wallets.solana.signAndSendTransaction(
				built.transaction,
				getSolanaConnection(from),
				built.signers,
			);
			update({ sourceTxHash: signature });
			try {
				await waitForSolanaConfirmation(from, signature, { signal: ctx.signal });
			} catch (error) {
				if (error instanceof TransactionRevertedError) {
					update({ sourceTxHash: undefined, droppedSourceTxHash: signature });
					throw error;
				}
				ctx.signal?.throwIfAborted();
				// Outcome unknown: keep the signature and wait for Circle (see the EVM case).
			}
			return signature;
		}
	}
}

async function mint(
	transfer: TransferRecord,
	to: ChainDefinition,
	ctx: TransferContext,
): Promise<string> {
	const message = hexToBytes(transfer.message!);
	const attestation = hexToBytes(transfer.attestation!);

	switch (to.ecosystem) {
		case 'sui': {
			const account = ctx.dAppKit.stores.$connection.get().account;
			const tx = buildSuiReceiveTransaction(to, message, attestation, account?.address);
			return executeSui(ctx, to, tx);
		}
		case 'evm': {
			const wallets = await ctx.wallets();
			const walletClient = await wallets.evm.getWalletClient(to);
			const hash = await evmReceiveMessage(
				walletClient,
				to,
				transfer.message as Hex,
				transfer.attestation as Hex,
			);
			return waitForEvmReceipt(to, hash);
		}
		case 'solana': {
			const wallets = await ctx.wallets();
			const payer = wallets.solana.getAccount();
			if (!payer) throw new Error('Connect a Solana wallet to claim');
			const payerKey = new PublicKey(payer.address);
			const connection = getSolanaConnection(to);
			const createAccount = await buildSolanaTokenAccountTransaction(
				to,
				payerKey,
				message,
				safePublicKey(transfer.recipient),
			);
			// Say so before the wallet is asked for anything: without this a wallet that is short
			// pays to create the token account and then cannot pay for the claim. If the balance
			// cannot be read, go ahead and let the wallet report what it finds.
			const funds = await getSolanaClaimFunds(to, payerKey, createAccount !== null).catch(
				() => null,
			);
			if (funds && funds.balance < funds.required) {
				throw new Error(
					`Claiming on Solana needs at least ${formatSol(funds.required, 'up')} SOL in the connected wallet for account rent and fees; it has ${formatSol(funds.balance, 'down')} SOL. Add SOL and claim again.`,
				);
			}
			if (createAccount) {
				const created = await wallets.solana.signAndSendTransaction(
					createAccount.transaction,
					connection,
				);
				await waitForSolanaConfirmation(to, created, { signal: ctx.signal });
			}
			const built = await buildSolanaReceiveTransaction(to, payerKey, message, attestation);
			const signature = await wallets.solana.signAndSendTransaction(built.transaction, connection);
			await waitForSolanaConfirmation(to, signature, { signal: ctx.signal });
			return signature;
		}
	}
}

/**
 * Sign and execute through dapp-kit on the chain's own network (not whatever network
 * dapp-kit happens to be on), surfacing Move aborts as readable errors.
 */
async function executeSui(
	ctx: TransferContext,
	chain: SuiChainDefinition,
	tx: ReturnType<typeof buildSuiBurnTransaction>,
	onDigest?: (digest: string) => void,
): Promise<string> {
	const network = chain.suiNetwork;
	const result = await ctx.dAppKit.signAndExecuteTransaction({ transaction: tx, network });
	if (result.$kind === 'FailedTransaction') {
		const error = result.FailedTransaction.status.error;
		throw new Error(error?.message ?? 'Sui transaction failed');
	}
	const digest = result.Transaction.digest;
	onDigest?.(digest);
	await ctx.dAppKit.getClient(network).core.waitForTransaction({ digest });
	return digest;
}

/** Best-effort "already minted?" check; any failure means "assume not", never a failed transfer. */
async function isNonceUsed(
	to: ChainDefinition,
	messageHex: string,
	ctx: TransferContext,
): Promise<boolean> {
	try {
		return await isNonceUsedUnsafe(to, messageHex, ctx);
	} catch {
		return false;
	}
}

async function isNonceUsedUnsafe(
	to: ChainDefinition,
	messageHex: string,
	ctx: TransferContext,
): Promise<boolean> {
	const parsed = parseMessageV2(messageHex);
	switch (to.ecosystem) {
		case 'evm':
			return evmIsNonceUsed(to, bytesToHex(parsed.nonce)).catch(() => false);
		case 'solana':
			return solanaIsNonceUsed(to, parsed.nonce).catch(() => false);
		case 'sui':
			// The Sui v2 package exposes no cheap public nonce lookup yet; the mint PTB aborts
			// if the nonce was already consumed and that surfaces as a failure the user can dismiss.
			void ctx;
			return false;
	}
}

/**
 * Encode the destination address as CCTP's 32-byte mint recipient. For Solana this is the
 * recipient's USDC associated token account, not the wallet address.
 */
export function mintRecipientBytes(recipient: string, to: ChainDefinition): Uint8Array {
	if (to.ecosystem === 'solana') {
		const owner = new PublicKey(recipient);
		return getAssociatedTokenAddress(new PublicKey(to.usdcMint), owner).toBytes();
	}
	return toBytes32(recipient, to);
}

function safePublicKey(value: string): PublicKey | undefined {
	try {
		return new PublicKey(value);
	} catch {
		return undefined;
	}
}

export function findChain(chains: ChainDefinition[], key: string): ChainDefinition {
	const chain = chains.find((c) => c.key === key);
	if (!chain) throw new Error(`Unknown chain "${key}"`);
	return chain;
}

/** Lamports as SOL to four decimal places. */
function formatSol(lamports: bigint, round: 'up' | 'down'): string {
	const unit = 100_000n; // 0.0001 SOL
	const units = (lamports + (round === 'up' ? unit - 1n : 0n)) / unit;
	return `${units / 10_000n}.${(units % 10_000n).toString().padStart(4, '0')}`;
}

export function errorMessage(error: unknown): string {
	if (error instanceof Error) return error.message;
	return String(error);
}

export type { EvmChainDefinition, SolanaChainDefinition, SuiChainDefinition };
