// Copyright (c) Mysten Labs, Inc.
// SPDX-License-Identifier: Apache-2.0

import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import type { Transaction } from '@solana/web3.js';
import { atom } from 'nanostores';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getChainRegistry } from '../../src/chains/index.js';
import { SOLANA_MAINNET } from '../../src/chains/solana.js';
import { isExpiredOnSui, runTransfer } from '../../src/core/transfer.js';
import type { AnyDAppKit, TransferRecord } from '../../src/core/types.js';
import * as evm from '../../src/engine/evm.js';
import { ASSOCIATED_TOKEN_PROGRAM_ID, getAssociatedTokenAddress } from '../../src/engine/solana.js';
import { IrisClient } from '../../src/iris/client.js';
import { MESSAGE_V2 } from '../../src/utils/bytes.js';
import { TransactionRevertedError } from '../../src/utils/errors.js';
import type { WalletAdapters } from '../../src/wallets/types.js';

vi.mock('../../src/engine/evm.js', async (original) => ({
	...(await original<typeof evm>()),
	getEvmUsdcAllowance: vi.fn(async () => 10n ** 12n),
	getEvmUsdcBalance: vi.fn(async () => 10n ** 12n),
	evmDepositForBurn: vi.fn(async () => BURN_HASH),
	waitForEvmReceipt: vi.fn(async (_chain: unknown, hash: string) => hash),
}));

const BURN_HASH = `0x${'ab'.repeat(32)}` as const;
const SUI_ADDRESS = `0x${'cd'.repeat(32)}`;
const EVM_ADDRESS = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
const chains = getChainRegistry('mainnet');

/** A v2 message with the given expiry (Sui reads it as milliseconds). */
function message(expiry: bigint, marker = 0xaa): `0x${string}` {
	const bytes = new Uint8Array(MESSAGE_V2.body + MESSAGE_V2.bodyFields.hookData).fill(marker);
	const view = new DataView(bytes.buffer);
	const at = MESSAGE_V2.body + MESSAGE_V2.bodyFields.expirationBlock;
	bytes.fill(0, at, at + 32);
	view.setBigUint64(at + 24, expiry);
	return hex(bytes);
}

function hex(bytes: Uint8Array): `0x${string}` {
	return `0x${[...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
}

const json = (status: number, body: unknown) =>
	new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function evmWallets(): () => Promise<WalletAdapters> {
	return async () =>
		({
			evm: { getWalletClient: async () => ({ account: { address: EVM_ADDRESS } }) },
			solana: {},
		}) as unknown as WalletAdapters;
}

function suiDAppKit() {
	const signAndExecuteTransaction = vi.fn(async () => ({
		$kind: 'Transaction',
		Transaction: { digest: 'C1v6NwPuxdXmaag9Wjcnq4TX65fh5QQj5nDVaSGeM39M' },
	}));
	const dAppKit = {
		stores: {
			$connection: atom({ account: { address: SUI_ADDRESS } }),
			$currentNetwork: atom('mainnet'),
		},
		getClient: () => ({ core: { waitForTransaction: vi.fn(async () => ({})) } }),
		signAndExecuteTransaction,
	} as unknown as AnyDAppKit;
	return { dAppKit, signAndExecuteTransaction };
}

const record = (over: Partial<TransferRecord>): TransferRecord => ({
	id: 't',
	network: 'mainnet',
	from: 'ethereum',
	to: 'sui',
	amount: '1000000',
	maxFee: '200',
	speed: 'fast',
	sender: EVM_ADDRESS,
	recipient: SUI_ADDRESS,
	status: 'pending',
	createdAt: 1,
	updatedAt: 1,
	...over,
});

describe('a burn whose outcome could not be read', () => {
	beforeEach(() => vi.mocked(evm.evmDepositForBurn).mockClear());

	it('keeps the burn hash when the receipt wait times out, and never burns twice', async () => {
		vi.mocked(evm.waitForEvmReceipt).mockRejectedValue(
			new Error('Timed out while waiting for transaction to be confirmed'),
		);
		const attested = {
			status: 'complete',
			message: message(0n),
			attestation: `0x${'bb'.repeat(65)}`,
		};
		const iris = new IrisClient('mainnet', {
			fetch: vi.fn<typeof fetch>(async () => json(200, { messages: [attested] })),
		});
		const updates: TransferRecord[] = [];
		const context = {
			dAppKit: suiDAppKit().dAppKit,
			wallets: evmWallets(),
			iris,
			chains,
			stopAfterAttestation: true,
			pollIntervalMs: 1,
			onUpdate: (t: TransferRecord) => updates.push(t),
		};
		const result = await runTransfer(record({}), context);
		expect(result.sourceTxHash).toBe(BURN_HASH);
		expect(result.status).toBe('readyToMint');
		// The hash was never dropped along the way.
		const afterBurn = updates.slice(updates.findIndex((u) => u.sourceTxHash));
		expect(afterBurn.every((u) => u.sourceTxHash === BURN_HASH)).toBe(true);
		// Running the saved record again resumes; it does not send another burn.
		await runTransfer(result, context);
		expect(evm.evmDepositForBurn).toHaveBeenCalledTimes(1);
	});

	it('drops the hash only when the burn was mined and reverted', async () => {
		vi.mocked(evm.waitForEvmReceipt).mockRejectedValue(
			new TransactionRevertedError('Transaction reverted on Ethereum'),
		);
		const updates: TransferRecord[] = [];
		await expect(
			runTransfer(record({}), {
				dAppKit: suiDAppKit().dAppKit,
				wallets: evmWallets(),
				iris: new IrisClient('mainnet', { fetch: vi.fn<typeof fetch>() }),
				chains,
				onUpdate: (t) => updates.push(t),
			}),
		).rejects.toThrow('reverted');
		expect(updates.at(-1)!.status).toBe('failed');
		expect(updates.at(-1)!.sourceTxHash).toBeUndefined();
	});
});

describe('an expired Fast Transfer into Sui', () => {
	it('knows when a message has expired', () => {
		const now = 1_800_000_000_000;
		expect(isExpiredOnSui(message(0n), now)).toBe(false); // standard: no expiry
		expect(isExpiredOnSui(message(BigInt(now + 3_600_000)), now)).toBe(false);
		expect(isExpiredOnSui(message(BigInt(now + 30_000)), now)).toBe(true); // inside the margin
		expect(isExpiredOnSui(message(BigInt(now - 1)), now)).toBe(true);
	});

	it('asks Circle to sign again and mints with the new attestation', async () => {
		const expired = message(BigInt(Date.now() - 1_000));
		const renewed = message(BigInt(Date.now() + 86_400_000), 0xcc);
		const oldAttestation = `0x${'11'.repeat(65)}`;
		const newAttestation = `0x${'22'.repeat(65)}`;
		let reattested = false;
		const calls: string[] = [];
		const iris = new IrisClient('mainnet', {
			fetch: vi.fn<typeof fetch>(async (input, init) => {
				const url = String(input);
				calls.push(`${init?.method ?? 'GET'} ${new URL(url).pathname}`);
				if (init?.method === 'POST' && url.includes('/v2/reattest/')) {
					reattested = true;
					return json(200, { message: 'Re-attestation successfully requested for nonce.' });
				}
				// Circle keeps returning the old attestation until the new one is signed.
				return json(200, {
					messages: [
						reattested
							? { status: 'complete', message: renewed, attestation: newAttestation }
							: { status: 'complete', message: expired, attestation: oldAttestation },
					],
				});
			}),
		});
		const { dAppKit, signAndExecuteTransaction } = suiDAppKit();
		const updates: TransferRecord[] = [];
		const result = await runTransfer(
			record({
				status: 'readyToMint',
				sourceTxHash: BURN_HASH,
				message: expired,
				attestation: oldAttestation,
			}),
			{
				dAppKit,
				wallets: evmWallets(),
				iris,
				chains,
				checkNonce: false,
				pollIntervalMs: 1,
				onUpdate: (t) => updates.push(t),
			},
		);
		expect(calls[0]).toMatch(/^POST \/v2\/reattest\/0x[0-9a-f]{64}$/);
		expect(result.status).toBe('complete');
		expect(result.message).toBe(renewed);
		expect(result.attestation).toBe(newAttestation);
		expect(signAndExecuteTransaction).toHaveBeenCalledTimes(1);
		expect(updates.map((u) => u.status)).toEqual(['attesting', 'attesting', 'minting', 'complete']);
	});

	it('leaves a message that is still valid alone', async () => {
		const valid = message(BigInt(Date.now() + 3_600_000));
		const fetchMock = vi.fn<typeof fetch>();
		const result = await runTransfer(
			record({
				status: 'readyToMint',
				sourceTxHash: BURN_HASH,
				message: valid,
				attestation: `0x${'11'.repeat(65)}`,
			}),
			{
				dAppKit: suiDAppKit().dAppKit,
				wallets: evmWallets(),
				iris: new IrisClient('mainnet', { fetch: fetchMock }),
				chains,
				checkNonce: false,
				onUpdate: () => undefined,
			},
		);
		expect(result.status).toBe('complete');
		expect(fetchMock).not.toHaveBeenCalled();
	});
});

type SendSolana = (...args: unknown[]) => Promise<string>;

function solanaWallets(address: string, signAndSendTransaction: SendSolana) {
	return async () =>
		({
			evm: {},
			solana: { getAccount: () => ({ address }), signAndSendTransaction },
		}) as unknown as WalletAdapters;
}

type SolanaStatus = { err: unknown; confirmationStatus: 'confirmed' | 'finalized' } | null;

/** What a lookup of any signature returns. */
function solanaSays(status: SolanaStatus | Error) {
	const spy = vi.spyOn(Connection.prototype, 'getSignatureStatuses');
	if (status instanceof Error) return spy.mockRejectedValue(status);
	return spy.mockResolvedValue({
		context: { slot: 10_000 },
		value: [status && { slot: 1, confirmations: null, ...status, err: status.err as never }],
	});
}

/** The chain is at block 1000 when a transaction is sent; `finalized` is how far it has got since. */
function solanaChainIs(chain: { finalized: number }) {
	vi.spyOn(Connection.prototype, 'getEpochInfo').mockImplementation(async (commitment) => ({
		absoluteSlot: 9_000,
		blockHeight: commitment === 'finalized' ? chain.finalized : 1_000,
		epoch: 1,
		slotIndex: 1,
		slotsInEpoch: 432_000,
	}));
}

function solanaAcceptsEverything() {
	vi.spyOn(Connection.prototype, 'getLatestBlockhash').mockResolvedValue({
		blockhash: '11111111111111111111111111111111',
		lastValidBlockHeight: 1,
	});
	solanaChainIs({ finalized: 1_000 });
	solanaSays({ err: null, confirmationStatus: 'confirmed' });
}

/** The USDC the burning wallet holds; `null` for no token account at all. */
function solanaWalletHolds(amount: bigint | null) {
	const account = Buffer.alloc(165);
	if (amount !== null) account.writeBigUInt64LE(amount, 64);
	vi.spyOn(Connection.prototype, 'getAccountInfo').mockResolvedValue(
		amount === null
			? null
			: { data: account, executable: false, lamports: 1, owner: Keypair.generate().publicKey },
	);
}

describe('a burn on Solana', () => {
	it('gives the wallet an unsigned transaction, and the event keypair to sign after it', async () => {
		solanaAcceptsEverything();
		solanaWalletHolds(5_000_000n);
		const owner = Keypair.generate().publicKey.toBase58();
		const signAndSendTransaction = vi.fn<SendSolana>(async () => 'solana-signature');
		const attested = {
			status: 'complete',
			message: message(0n),
			attestation: `0x${'bb'.repeat(65)}`,
		};
		const result = await runTransfer(record({ from: 'solana', sender: owner }), {
			dAppKit: suiDAppKit().dAppKit,
			wallets: solanaWallets(owner, signAndSendTransaction),
			iris: new IrisClient('mainnet', {
				fetch: vi.fn<typeof fetch>(async () => json(200, { messages: [attested] })),
			}),
			chains,
			stopAfterAttestation: true,
			pollIntervalMs: 1,
			onUpdate: () => undefined,
		});
		expect(result.sourceTxHash).toBe('solana-signature');
		const [transaction, , signers] = signAndSendTransaction.mock.calls[0]! as [
			Transaction,
			unknown,
			Keypair[],
		];
		expect(signers).toHaveLength(1);
		expect(transaction.signatures.every((s) => !s.signature)).toBe(true);
	});
});

describe('a burn the wallet cannot pay for', () => {
	it('is stopped before the Solana wallet is asked', async () => {
		// A retried transfer whose USDC was bridged by another one in the meantime: the wallet
		// would only say it is short of SOL.
		solanaAcceptsEverything();
		solanaWalletHolds(0n);
		const owner = Keypair.generate().publicKey.toBase58();
		const signAndSendTransaction = vi.fn<SendSolana>();
		await expect(
			runTransfer(record({ from: 'solana', sender: owner, amount: '500000' }), {
				dAppKit: suiDAppKit().dAppKit,
				wallets: solanaWallets(owner, signAndSendTransaction),
				iris: new IrisClient('mainnet', { fetch: vi.fn<typeof fetch>() }),
				chains,
				onUpdate: () => undefined,
			}),
		).rejects.toThrow('Not enough USDC on Solana: the wallet holds 0 and this transfer needs 0.5.');
		expect(signAndSendTransaction).not.toHaveBeenCalled();
	});

	it('is stopped before an EVM wallet is asked to approve or burn', async () => {
		vi.mocked(evm.getEvmUsdcBalance).mockResolvedValueOnce(250_000n);
		vi.mocked(evm.evmDepositForBurn).mockClear();
		await expect(
			runTransfer(record({}), {
				dAppKit: suiDAppKit().dAppKit,
				wallets: evmWallets(),
				iris: new IrisClient('mainnet', { fetch: vi.fn<typeof fetch>() }),
				chains,
				onUpdate: () => undefined,
			}),
		).rejects.toThrow(
			'Not enough USDC on Ethereum: the wallet holds 0.25 and this transfer needs 1.',
		);
		expect(evm.evmDepositForBurn).not.toHaveBeenCalled();
	});

	it('goes ahead when the balance cannot be read', async () => {
		solanaAcceptsEverything();
		vi.spyOn(Connection.prototype, 'getAccountInfo').mockRejectedValue(new Error('403 Forbidden'));
		const owner = Keypair.generate().publicKey.toBase58();
		const signAndSendTransaction = vi.fn<SendSolana>(async () => 'solana-signature');
		const attested = {
			status: 'complete',
			message: message(0n),
			attestation: `0x${'bb'.repeat(65)}`,
		};
		const result = await runTransfer(record({ from: 'solana', sender: owner }), {
			dAppKit: suiDAppKit().dAppKit,
			wallets: solanaWallets(owner, signAndSendTransaction),
			iris: new IrisClient('mainnet', {
				fetch: vi.fn<typeof fetch>(async () => json(200, { messages: [attested] })),
			}),
			chains,
			stopAfterAttestation: true,
			pollIntervalMs: 1,
			onUpdate: () => undefined,
		});
		expect(result.sourceTxHash).toBe('solana-signature');
	});
});

describe('a Solana burn that was written off as expired', () => {
	const owner = Keypair.generate().publicKey.toBase58();
	const context = (signAndSendTransaction: SendSolana, updates: TransferRecord[] = []) => ({
		dAppKit: suiDAppKit().dAppKit,
		wallets: solanaWallets(owner, signAndSendTransaction),
		iris: new IrisClient('mainnet', {
			fetch: vi.fn<typeof fetch>(async () =>
				json(200, {
					messages: [
						{ status: 'complete', message: message(0n), attestation: `0x${'bb'.repeat(65)}` },
					],
				}),
			),
		}),
		chains,
		stopAfterAttestation: true,
		pollIntervalMs: 1,
		onUpdate: (t: TransferRecord) => updates.push(t),
	});

	it('is remembered when the transfer gives it up', async () => {
		solanaAcceptsEverything();
		solanaWalletHolds(5_000_000n);
		// Unknown to every node, and the finalized chain is past any block that could carry it.
		solanaSays(null);
		solanaChainIs({ finalized: 1_000 + 150 + 150 + 1 });
		const updates: TransferRecord[] = [];
		await expect(
			runTransfer(
				record({ from: 'solana', sender: owner }),
				context(async () => 'first-signature', updates),
			),
		).rejects.toThrow(/expired before it was included/);
		expect(updates.at(-1)).toMatchObject({
			status: 'failed',
			droppedSourceTxHash: 'first-signature',
		});
		expect(updates.at(-1)!.sourceTxHash).toBeUndefined();
	});

	it('is taken back, with no second burn, if it turns out to have gone through', async () => {
		solanaAcceptsEverything();
		solanaWalletHolds(5_000_000n);
		const signAndSendTransaction = vi.fn<SendSolana>();
		const result = await runTransfer(
			record({
				from: 'solana',
				sender: owner,
				status: 'failed',
				droppedSourceTxHash: 'first-signature',
			}),
			context(signAndSendTransaction),
		);
		expect(signAndSendTransaction).not.toHaveBeenCalled();
		expect(result.sourceTxHash).toBe('first-signature');
		expect(result.droppedSourceTxHash).toBeUndefined();
		expect(result.status).toBe('readyToMint');
	});

	it('is not burned again while nobody can say what became of it', async () => {
		solanaAcceptsEverything();
		solanaWalletHolds(5_000_000n);
		solanaSays(new Error('node says no'));
		const signAndSendTransaction = vi.fn<SendSolana>();
		await expect(
			runTransfer(
				record({
					from: 'solana',
					sender: owner,
					status: 'failed',
					droppedSourceTxHash: 'first-signature',
				}),
				context(signAndSendTransaction),
			),
		).rejects.toThrow(/Could not check whether the earlier burn went through/);
		expect(signAndSendTransaction).not.toHaveBeenCalled();
	});

	it('is burned again once the chain confirms it never happened', async () => {
		solanaAcceptsEverything();
		solanaWalletHolds(5_000_000n);
		// The earlier signature is unknown; the new one confirms.
		vi.spyOn(Connection.prototype, 'getSignatureStatuses').mockImplementation(
			async (signatures) => ({
				context: { slot: 10_000 },
				value: [
					signatures[0] === 'first-signature'
						? null
						: { slot: 1, confirmations: null, err: null, confirmationStatus: 'confirmed' },
				],
			}),
		);
		const signAndSendTransaction = vi.fn<SendSolana>(async () => 'second-signature');
		const result = await runTransfer(
			record({
				from: 'solana',
				sender: owner,
				status: 'failed',
				droppedSourceTxHash: 'first-signature',
			}),
			context(signAndSendTransaction),
		);
		expect(signAndSendTransaction).toHaveBeenCalledTimes(1);
		expect(result.sourceTxHash).toBe('second-signature');
	});
});

describe('claiming on Solana', () => {
	const owner = Keypair.generate().publicKey;
	const tokenAccount = getAssociatedTokenAddress(new PublicKey(SOLANA_MAINNET.usdcMint), owner);

	function claim(): TransferRecord {
		const bytes = new Uint8Array(MESSAGE_V2.body + MESSAGE_V2.bodyFields.hookData);
		new DataView(bytes.buffer).setUint32(MESSAGE_V2.sourceDomain, 8);
		bytes.set(tokenAccount.toBytes(), MESSAGE_V2.body + MESSAGE_V2.bodyFields.mintRecipient);
		return record({
			from: 'sui',
			to: 'solana',
			speed: 'standard',
			maxFee: '0',
			sender: SUI_ADDRESS,
			recipient: owner.toBase58(),
			status: 'readyToMint',
			sourceTxHash: 'C1v6NwPuxdXmaag9Wjcnq4TX65fh5QQj5nDVaSGeM39M',
			message: hex(bytes),
			attestation: `0x${'11'.repeat(65)}`,
		});
	}

	/** A recipient with no USDC account yet, and mainnet's rent minimums on 2026-10-05. */
	function solana(balance: number | Error) {
		solanaAcceptsEverything();
		const tokenMessenger = Buffer.alloc(8 + 32 + 32 + 32 + 4 + 1 + 32 + 32 + 4);
		vi.spyOn(Connection.prototype, 'getAccountInfo').mockImplementation(async (key) =>
			(key as PublicKey).equals(tokenAccount)
				? null
				: { data: tokenMessenger, executable: false, lamports: 1, owner },
		);
		vi.spyOn(Connection.prototype, 'getMinimumBalanceForRentExemption').mockImplementation(
			async (size) => ({ 0: 650_240, 9: 695_960, 165: 1_488_440 })[size]!,
		);
		const getBalance = vi.spyOn(Connection.prototype, 'getBalance');
		if (balance instanceof Error) getBalance.mockRejectedValue(balance);
		else getBalance.mockResolvedValue(balance);
	}

	const context = (signAndSendTransaction: SendSolana) => ({
		dAppKit: suiDAppKit().dAppKit,
		wallets: solanaWallets(owner.toBase58(), signAndSendTransaction),
		iris: new IrisClient('mainnet', { fetch: vi.fn<typeof fetch>() }),
		chains,
		checkNonce: false,
		onUpdate: () => undefined,
	});

	it('says how much SOL is needed before the wallet is asked for anything', async () => {
		// What the first real claim through the widget started with: enough to create the token
		// account, not enough to pay for the claim after it.
		solana(2_611_000);
		const signAndSendTransaction = vi.fn<SendSolana>();
		await expect(runTransfer(claim(), context(signAndSendTransaction))).rejects.toThrow(
			/needs at least 0\.0029 SOL .* it has 0\.0026 SOL/,
		);
		expect(signAndSendTransaction).not.toHaveBeenCalled();
	});

	it('creates the token account and then claims when the wallet can pay for both', async () => {
		solana(2_900_000);
		const signAndSendTransaction = vi
			.fn<SendSolana>()
			.mockResolvedValueOnce('created')
			.mockResolvedValueOnce('claimed');
		const result = await runTransfer(claim(), context(signAndSendTransaction));
		expect(result.status).toBe('complete');
		expect(result.destinationTxHash).toBe('claimed');
		const programs = signAndSendTransaction.mock.calls.map(([transaction]) =>
			(transaction as Transaction).instructions.map((i) => i.programId.toBase58()),
		);
		expect(programs).toEqual([
			[ASSOCIATED_TOKEN_PROGRAM_ID.toBase58()],
			[SOLANA_MAINNET.messageTransmitterV2],
		]);
	});

	it('goes ahead when the balance cannot be read', async () => {
		solana(new Error('403 Forbidden'));
		const signAndSendTransaction = vi.fn<SendSolana>(async () => 'sent');
		const result = await runTransfer(claim(), context(signAndSendTransaction));
		expect(result.status).toBe('complete');
		expect(signAndSendTransaction).toHaveBeenCalledTimes(2);
	});
});
