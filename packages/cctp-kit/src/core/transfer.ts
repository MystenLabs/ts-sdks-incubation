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
	getEvmNativeBalance,
	getEvmUsdcAllowance,
	getEvmUsdcBalance,
	isEvmContract,
	waitForEvmReceipt,
} from '../engine/evm.js';
import {
	buildSolanaBurnTransaction,
	buildSolanaReceiveTransaction,
	buildSolanaTokenAccountTransaction,
	getAssociatedTokenAddress,
	getSolanaClaimFunds,
	getSolanaConnection,
	getSolanaLastPossibleBlock,
	getSolanaUsdcBalance,
	hasSolanaTransactionSucceeded,
	solanaIsNonceUsed,
	waitForSolanaConfirmation,
} from '../engine/solana.js';
import {
	buildSuiBurnTransaction,
	buildSuiReceiveTransaction,
	getSuiUsdcBalance,
	suiIsNonceUsed,
} from '../engine/sui.js';
import type { IrisClient, IrisMessage } from '../iris/client.js';
import { formatUsdc } from '../utils/amount.js';
import { bytesToHex, hexToBytes, parseMessageV2, toBytes32 } from '../utils/bytes.js';
import type { Hex } from '../utils/bytes.js';
import {
	CctpKitError,
	describeError,
	gasShortfallMessage,
	isBlockedWindow,
	TransactionRevertedError,
} from '../utils/errors.js';
import { sleep } from '../utils/sleep.js';
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
	/** How long to wait before asking the source chain again about a burn it could not vouch for (defaults to 15 s). */
	confirmRetryMs?: number;
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
	// A run that begins with the attestation in hand was started by someone pressing Claim.
	const startedAtClaim = !!record.attestation && !!record.message;

	try {
		if (!transfer.sourceTxHash) {
			// Sends the burn and records its hash. Whether it is on chain is settled below, the
			// same way for a burn just sent and for one found in a record after a reload.
			await burn(transfer, from, to, ctx, update);
		}

		if (!transfer.attestation || !transfer.message) {
			ctx.signal?.throwIfAborted();
			const attested = await attest(() => transfer, from, ctx, update);
			update({
				status: 'readyToMint',
				message: attested.message,
				attestation: attested.attestation,
			});
		} else if (transfer.status !== 'readyToMint' && transfer.status !== 'minting') {
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
			// A Sui wallet that signs in a window of its own can only open it while the press
			// that asked for the claim is still being handled. So on a Claim press nothing is
			// awaited on the way to a Sui wallet. Whether the message was claimed already is
			// looked at when the page loads, and here only if the claim then fails.
			const inPress =
				startedAtClaim && to.ecosystem === 'sui' && !isExpiredOnSui(transfer.message!);
			const claimed = () =>
				ctx.checkNonce === false ? false : isNonceUsed(to, transfer.message!, ctx);
			if (!inPress && (await claimed())) {
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
			let destinationTxHash: string;
			try {
				destinationTxHash = await mint(transfer, to, ctx, update);
			} catch (error) {
				if (ctx.signal?.aborted || to.ecosystem !== 'sui') throw error;
				if (inPress && (await claimed())) {
					// It failed because it had been made already, from elsewhere.
					update({ status: 'complete', completedAt: Date.now() });
					return transfer;
				}
				if (!inPress && isBlockedWindow(error)) {
					// The claim follows the attestation by itself, minutes after anyone pressed
					// anything, and the browser would not open the wallet's window for it. That is
					// not a failure: the transfer waits at Claim, where a press will open it.
					update({ status: 'readyToMint' });
					return transfer;
				}
				throw error;
			}
			update({ status: 'complete', destinationTxHash, completedAt: Date.now() });
		} else {
			update({ status: 'complete', completedAt: transfer.completedAt ?? Date.now() });
		}
		return transfer;
	} catch (error) {
		if (ctx.signal?.aborted) throw error;
		// A wallet fails on the source chain until the burn is sent, and on the destination once
		// there is something to claim.
		const chain = transfer.attestation ? to : transfer.sourceTxHash ? undefined : from;
		update({ status: 'failed', error: describeError(error, { chain }) });
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

const GAS_CHECK_MS = 5_000;

/** Whether an account plainly cannot pay for gas: it has a key of its own and holds nothing. */
async function cannotPayGas(chain: EvmChainDefinition, payer: Hex): Promise<boolean> {
	const giveUp = new AbortController();
	const answer = await Promise.race([
		Promise.all([getEvmNativeBalance(chain, payer), isEvmContract(chain, payer)]).then(
			([balance, contract]) => balance === 0n && !contract,
			() => false,
		),
		// A node that does not answer must not hold the failure up.
		sleep(GAS_CHECK_MS, giveUp.signal).then(
			() => false,
			() => false,
		),
	]);
	giveUp.abort();
	return answer;
}

/**
 * Make a request that an EVM wallet pays gas for. When it fails and the paying account plainly
 * cannot pay, say that, whatever words the wallet or its node found for it. Someone bridging to
 * a chain for the first time is often in exactly that position.
 *
 * This is looked at after the failure, never before the request. A Safe, or an account whose
 * gas is paid for it, can hold nothing and still go through, and a claim that is stopped
 * wrongly, after the burn, is the worst thing this could do.
 */
async function payingGas<T>(
	chain: EvmChainDefinition,
	payer: Hex | undefined,
	request: () => Promise<T>,
): Promise<T> {
	try {
		return await request();
	} catch (error) {
		if (error instanceof CctpKitError || !payer || !(await cannotPayGas(chain, payer))) throw error;
		throw new CctpKitError(gasShortfallMessage(chain), { cause: error });
	}
}

/**
 * A transfer is burned by the wallet it was started from. Retry and Resume skip the form, so
 * without this a transfer started from one account would burn whichever account is connected
 * now, towards the first one's recipient.
 */
function assertSender(transfer: TransferRecord, from: ChainDefinition, connected?: string) {
	const same =
		!!connected &&
		(connected === transfer.sender ||
			(connected.startsWith('0x') && connected.toLowerCase() === transfer.sender.toLowerCase()));
	if (same) return;
	const sender = transfer.sender;
	const short = sender.length > 14 ? `${sender.slice(0, 6)}…${sender.slice(-4)}` : sender;
	throw new Error(
		`This transfer was started from ${short} on ${from.name}. Connect that wallet to continue.`,
	);
}

async function burn(
	transfer: TransferRecord,
	from: ChainDefinition,
	to: ChainDefinition,
	ctx: TransferContext,
	update: (patch: Partial<TransferRecord>) => TransferRecord,
): Promise<void> {
	const amount = BigInt(transfer.amount);
	const maxFee = BigInt(transfer.maxFee);
	const minFinalityThreshold = transfer.speed === 'fast' ? 1000 : 2000;
	const mintRecipient = mintRecipientBytes(transfer.recipient, to);

	switch (from.ecosystem) {
		case 'sui': {
			// Nothing is awaited before the wallet is asked: a Sui wallet that signs in a window
			// it opens itself can only open it while the click is still being handled. The SDK
			// reports a short balance when it builds the transaction.
			assertSender(transfer, from, ctx.dAppKit.stores.$connection.get().account?.address);
			update({ status: 'burning' });
			const tx = buildSuiBurnTransaction(from, {
				sender: transfer.sender,
				amount,
				destinationDomain: to.domain,
				mintRecipient,
				maxFee,
				minFinalityThreshold,
			});
			await executeSui(ctx, from, tx, (digest) => update({ sourceTxHash: digest }));
			return;
		}
		case 'evm': {
			const wallets = await ctx.wallets();
			const walletClient = await wallets.evm.getWalletClient(from);
			const owner = walletClient.account?.address;
			assertSender(transfer, from, owner);
			await assertSourceBalance(from, owner!, amount, ctx);
			const allowance = await getEvmUsdcAllowance(from, owner!);
			if (allowance < amount) {
				ctx.signal?.throwIfAborted();
				update({ status: 'approving' });
				await payingGas(from, owner, () => approveEvmUsdc(walletClient, from, amount));
			}
			// The approval can take minutes. If the kit was torn down meanwhile, stop here rather
			// than open a burn request nobody is waiting for.
			ctx.signal?.throwIfAborted();
			update({ status: 'burning' });
			const hash = await payingGas(from, owner, () =>
				evmDepositForBurn(walletClient, from, {
					amount,
					destinationDomain: to.domain,
					mintRecipient: bytesToHex(mintRecipient),
					maxFee,
					minFinalityThreshold,
				}),
			);
			update({ sourceTxHash: hash });
			return;
		}
		case 'solana': {
			const wallets = await ctx.wallets();
			assertSender(transfer, from, wallets.solana.getAccount()?.address);
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
					return;
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
			ctx.signal?.throwIfAborted();
			const signature = await wallets.solana.signAndSendTransaction(
				built.transaction,
				getSolanaConnection(from),
				built.signers,
			);
			update({ sourceTxHash: signature, droppedSourceTxHash: undefined });
			// Taken after the wallet has signed, so it holds whatever blockhash the wallet used.
			const lastBlock = await getSolanaLastPossibleBlock(from);
			if (lastBlock !== null) update({ sourceTxLastBlock: lastBlock });
			return;
		}
	}
}

/**
 * Wait for Circle to attest the burn, and meanwhile make sure the burn is really there.
 *
 * A recorded hash only says a burn was sent. Until the source chain has shown it, the chain is
 * watched alongside Circle: a burn that reverted, was cancelled or replaced in the wallet, or
 * expired is taken out of the record so the transfer can be tried again, and one that was sped
 * up is followed to the hash it was mined under. Circle attesting it settles the question too.
 * This runs the same for a burn sent a moment ago and for one found in a record after a reload.
 */
async function attest(
	current: () => TransferRecord,
	from: ChainDefinition,
	ctx: TransferContext,
	update: (patch: Partial<TransferRecord>) => TransferRecord,
): Promise<IrisMessage> {
	for (;;) {
		const transfer = current();
		const hash = transfer.sourceTxHash!;
		const waitForCircle = (signal?: AbortSignal) =>
			ctx.iris.waitForAttestation(from.domain, hash, { signal, intervalMs: ctx.pollIntervalMs });

		if (transfer.sourceConfirmed) {
			if (transfer.status !== 'attesting' || !transfer.attestingSince) {
				update({ status: 'attesting', attestingSince: transfer.attestingSince ?? Date.now() });
			}
			return waitForCircle(ctx.signal);
		}

		// A burn just sent is "burning" until the chain answers. One found in a record in any
		// other state is shown as waiting, as it was before this check existed.
		const waiting = () => {
			const now = current();
			if (now.status !== 'attesting' || !now.attestingSince) {
				update({ status: 'attesting', attestingSince: now.attestingSince ?? Date.now() });
			}
		};
		if (transfer.status !== 'burning') waiting();
		const stop = new AbortController();
		const stopWithCaller = () => stop.abort(ctx.signal?.reason);
		if (ctx.signal?.aborted) stopWithCaller();
		else ctx.signal?.addEventListener('abort', stopWithCaller, { once: true });
		const circle = waitForCircle(stop.signal).then((attested) => ({ attested }));
		// When the chain cannot say, stop holding the form for it: show the transfer as waiting
		// for Circle, and keep watching the chain behind that.
		const chain = confirmSource(transfer, from, ctx, stop.signal, waiting).then((mined) => ({
			mined,
		}));
		// Whichever loses the race is stopped below; its rejection is expected.
		circle.catch(() => undefined);
		chain.catch(() => undefined);
		try {
			const first = await Promise.race([circle, chain]);
			const now = Date.now();
			const { burnedAt = now, attestingSince = now } = current();
			if ('attested' in first) {
				// Circle only attests a burn that happened.
				update({ sourceConfirmed: true, burnedAt, attestingSince });
				return first.attested;
			}
			update({
				sourceTxHash: first.mined,
				sourceConfirmed: true,
				burnedAt,
				status: 'attesting',
				attestingSince,
			});
			if (first.mined === hash) return (await circle).attested;
			// Mined under another hash: go round again and ask Circle for that one.
		} catch (error) {
			if (error instanceof TransactionRevertedError) {
				// The burn moved no funds and never will. Drop the hash so the transfer can be
				// tried again, instead of waiting on an attestation that cannot come.
				update({
					sourceTxHash: undefined,
					sourceTxLastBlock: undefined,
					burnedAt: undefined,
					...(from.ecosystem === 'solana' ? { droppedSourceTxHash: hash } : {}),
				});
			}
			throw error;
		} finally {
			ctx.signal?.removeEventListener('abort', stopWithCaller);
			stop.abort();
		}
	}
}

/**
 * Resolve with the hash the burn was confirmed under once the source chain shows it. Rejects
 * with `TransactionRevertedError` when the chain rules it out. While the chain cannot say, as
 * when its RPC is failing or the burn is not mined within one wait, it asks again.
 */
async function confirmSource(
	transfer: TransferRecord,
	from: ChainDefinition,
	ctx: TransferContext,
	signal: AbortSignal,
	onInconclusive: () => void,
): Promise<string> {
	const hash = transfer.sourceTxHash!;
	for (;;) {
		signal.throwIfAborted();
		try {
			switch (from.ecosystem) {
				case 'sui':
					// A Sui digest exists only once the transaction has executed.
					return hash;
				case 'evm':
					return await waitForEvmReceipt(from, hash as Hex);
				case 'solana':
					await waitForSolanaConfirmation(from, hash, {
						signal,
						lastPossibleBlock: transfer.sourceTxLastBlock,
						// An earlier version stamped a time on a burn it had only sent, and kept no
						// last block. Nothing in such a record says when the burn was sent, so a
						// node that does not know it proves nothing: it may not reach back that far.
						canExpire: transfer.sourceTxLastBlock !== undefined || !transfer.burnedAt,
					});
					return hash;
			}
		} catch (error) {
			if (error instanceof TransactionRevertedError) throw error;
			signal.throwIfAborted();
			onInconclusive();
		}
		await sleep(ctx.confirmRetryMs ?? 15_000, signal);
	}
}

async function mint(
	transfer: TransferRecord,
	to: ChainDefinition,
	ctx: TransferContext,
	update: (patch: Partial<TransferRecord>) => TransferRecord,
): Promise<string> {
	const message = hexToBytes(transfer.message!);
	const attestation = hexToBytes(transfer.attestation!);

	switch (to.ecosystem) {
		case 'sui': {
			const account = ctx.dAppKit.stores.$connection.get().account;
			if (!account) throw new CctpKitError('Connect a Sui wallet to claim.');
			const tx = buildSuiReceiveTransaction(to, message, attestation, account.address);
			// Keep the digest the moment there is one. The message is spent from here on, so a
			// claim that is forgotten can never be made again.
			return executeSui(ctx, to, tx, (digest) => update({ destinationTxHash: digest }));
		}
		case 'evm': {
			const wallets = await ctx.wallets();
			const walletClient = await wallets.evm.getWalletClient(to);
			ctx.signal?.throwIfAborted();
			// Whoever claims pays the gas, which need not be the recipient.
			const hash = await payingGas(to, walletClient.account?.address, () =>
				evmReceiveMessage(walletClient, to, transfer.message as Hex, transfer.attestation as Hex),
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
			ctx.signal?.throwIfAborted();
			if (createAccount) {
				const created = await wallets.solana.signAndSendTransaction(
					createAccount.transaction,
					connection,
				);
				await waitForSolanaConfirmation(to, created, { signal: ctx.signal });
			}
			const built = await buildSolanaReceiveTransaction(to, payerKey, message, attestation);
			ctx.signal?.throwIfAborted();
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
	// The transaction has executed. Waiting only gives the node time to index it, so a wait
	// that fails is no reason to fail a transfer whose transaction went through.
	await ctx.dAppKit
		.getClient(network)
		.core.waitForTransaction({ digest })
		.catch(() => undefined);
	return digest;
}

/** Best-effort "already minted?" check; any failure means "assume not", never a failed transfer. */
export async function isNonceUsed(
	to: ChainDefinition,
	messageHex: string,
	ctx: Pick<TransferContext, 'dAppKit'>,
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
	ctx: Pick<TransferContext, 'dAppKit'>,
): Promise<boolean> {
	const parsed = parseMessageV2(messageHex);
	switch (to.ecosystem) {
		case 'evm':
			return evmIsNonceUsed(to, bytesToHex(parsed.nonce)).catch(() => false);
		case 'solana':
			return solanaIsNonceUsed(to, parsed.nonce).catch(() => false);
		case 'sui':
			return suiIsNonceUsed(ctx.dAppKit.getClient(to.suiNetwork), to, parsed.nonce);
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

export type { EvmChainDefinition, SolanaChainDefinition, SuiChainDefinition };
