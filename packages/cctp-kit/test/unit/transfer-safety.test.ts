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
	getEvmNativeBalance: vi.fn(async () => 10n ** 18n),
	isEvmContract: vi.fn(async () => false),
	approveEvmUsdc: vi.fn(async () => BURN_HASH),
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

const SUI_DIGEST = 'C1v6NwPuxdXmaag9Wjcnq4TX65fh5QQj5nDVaSGeM39M';

/**
 * A dapp-kit with a connected Sui account. `core` adds to, or replaces, what its client can do;
 * by default it can only wait for a transaction, so the "already claimed" lookup is unanswered.
 */
function suiDAppKit(options: { account?: string | null; core?: Record<string, unknown> } = {}) {
	const signAndExecuteTransaction = vi.fn(async () => ({
		$kind: 'Transaction',
		Transaction: { digest: SUI_DIGEST },
	}));
	const account = options.account === undefined ? SUI_ADDRESS : options.account;
	const core = { waitForTransaction: vi.fn(async () => ({})), ...options.core };
	const dAppKit = {
		stores: {
			$connection: atom({ account: account ? { address: account } : null }),
			$currentNetwork: atom('mainnet'),
		},
		getClient: () => ({ core }),
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
		// 'minting' twice: once when the claim starts, once when its digest is recorded.
		expect(updates.map((u) => u.status)).toEqual([
			'attesting',
			'attesting',
			'minting',
			'minting',
			'complete',
		]);
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

	it('is told it has nothing to pay gas with when an EVM wallet turns the burn down', async () => {
		// The wallet is asked: an account can hold nothing and still pay, if it is a contract or
		// its gas is paid for it. Only when the request fails is the balance looked at.
		const refusal = new Error('transaction underpriced or something the wallet made up');
		vi.mocked(evm.evmDepositForBurn).mockReset().mockRejectedValue(refusal);
		const burnWith = (updates: TransferRecord[] = []) => ({
			dAppKit: suiDAppKit().dAppKit,
			wallets: evmWallets(),
			iris: new IrisClient('mainnet', { fetch: vi.fn<typeof fetch>() }),
			chains,
			onUpdate: (t: TransferRecord) => updates.push(t),
		});
		const updates: TransferRecord[] = [];

		vi.mocked(evm.getEvmNativeBalance).mockResolvedValueOnce(0n);
		await expect(runTransfer(record({}), burnWith(updates))).rejects.toThrow(
			'The wallet does not have enough ETH on Ethereum to pay for gas. Add some ETH on Ethereum, then try again.',
		);
		expect(evm.evmDepositForBurn).toHaveBeenCalledTimes(1);
		expect(updates.at(-1)).toMatchObject({ status: 'failed' });
		expect(updates.at(-1)!.sourceTxHash).toBeUndefined();

		// With something in the wallet, or a balance nobody can read, the wallet's words stand.
		await expect(runTransfer(record({}), burnWith())).rejects.toBe(refusal);
		vi.mocked(evm.getEvmNativeBalance).mockRejectedValueOnce(new Error('HTTP request failed'));
		await expect(runTransfer(record({}), burnWith())).rejects.toBe(refusal);
		// A contract account holding nothing is not told to add gas: it may not be what pays.
		vi.mocked(evm.getEvmNativeBalance).mockResolvedValueOnce(0n);
		vi.mocked(evm.isEvmContract).mockResolvedValueOnce(true);
		await expect(runTransfer(record({}), burnWith())).rejects.toBe(refusal);

		vi.mocked(evm.evmDepositForBurn)
			.mockReset()
			.mockImplementation(async () => BURN_HASH);
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

describe('a claim on an EVM chain by a wallet with nothing to pay gas with', () => {
	// Someone bridging to a chain for the first time. The wallet's node answered "gas required
	// exceeds allowance (0)", and the card showed that inside forty lines of call data.
	const GAS_ADVICE =
		'The wallet does not have enough ETH on Base to pay for gas. Add some ETH on Base, then try again.';
	const waiting = () =>
		record({
			from: 'sui',
			to: 'base',
			sender: SUI_ADDRESS,
			recipient: EVM_ADDRESS,
			status: 'readyToMint',
			sourceTxHash: SUI_DIGEST,
			sourceConfirmed: true,
			message: message(0n),
			attestation: `0x${'bb'.repeat(65)}`,
		});
	const claimWith = (writeContract: () => Promise<string>, updates: TransferRecord[] = []) => ({
		dAppKit: suiDAppKit().dAppKit,
		wallets: async () =>
			({
				evm: {
					getWalletClient: async () => ({ account: { address: EVM_ADDRESS }, writeContract }),
				},
				solana: {},
			}) as unknown as WalletAdapters,
		iris: new IrisClient('mainnet', { fetch: vi.fn<typeof fetch>() }),
		chains,
		checkNonce: false,
		onUpdate: (t: TransferRecord) => updates.push(t),
	});
	const receiptsArrive = () =>
		vi
			.mocked(evm.waitForEvmReceipt)
			.mockReset()
			.mockImplementation(async (_chain, hash) => hash);

	it('says what to add where, whatever the wallet said', async () => {
		// The wallet's words here are a plain refusal that names no cause at all.
		vi.mocked(evm.getEvmNativeBalance).mockResolvedValueOnce(0n);
		const writeContract = vi.fn(async (): Promise<string> => {
			throw new Error('Something went wrong');
		});
		const updates: TransferRecord[] = [];
		await expect(runTransfer(waiting(), claimWith(writeContract, updates))).rejects.toThrow(
			GAS_ADVICE,
		);
		expect(updates.at(-1)).toMatchObject({ status: 'failed', error: GAS_ADVICE });
		// Nothing is lost: the attestation is still there to claim with.
		expect(updates.at(-1)!.attestation).toBeTruthy();
	});

	it('says the same when the wallet has some, and its node says it is too little', async () => {
		const writeContract = vi.fn(async (): Promise<string> => {
			throw Object.assign(
				new Error(
					`The contract function "receiveMessage" reverted with the following reason:\nRPC 0x2105 Infura eth_sendRawTransaction: gas required exceeds allowance (0)\n\nContract Call:\n  args: (0x${'00'.repeat(376)})\n\nVersion: viem@2.57.3`,
				),
				{ name: 'ContractFunctionExecutionError' },
			);
		});
		const updates: TransferRecord[] = [];
		await expect(runTransfer(waiting(), claimWith(writeContract, updates))).rejects.toThrow();
		expect(updates.at(-1)!.error).toBe(GAS_ADVICE);
	});

	it('is never stopped beforehand: an account that holds nothing may still be able to pay', async () => {
		// A Safe whose owner pays, or an account whose gas is paid for it. Stopping it on its
		// balance, after the burn, would strand a claim that works.
		receiptsArrive();
		vi.mocked(evm.getEvmNativeBalance).mockResolvedValue(0n);
		const writeContract = vi.fn(async () => BURN_HASH);
		const result = await runTransfer(waiting(), claimWith(writeContract));
		expect(writeContract).toHaveBeenCalledTimes(1);
		expect(result.status).toBe('complete');
		vi.mocked(evm.getEvmNativeBalance)
			.mockReset()
			.mockImplementation(async () => 10n ** 18n);
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
			runTransfer(record({ from: 'solana', sender: owner }), {
				...context(async () => 'first-signature', updates),
				// Circle has nothing to say about a burn that never landed.
				iris: new IrisClient('mainnet', {
					fetch: vi.fn<typeof fetch>(async () => json(404, { error: 'not found' })),
				}),
			}),
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

describe('a transfer is burned by the wallet it was started from', () => {
	const noIris = () => new IrisClient('mainnet', { fetch: vi.fn<typeof fetch>() });
	const OTHER_EVM = '0x1111111111111111111111111111111111111111';

	it('refuses an EVM burn from another account, before approving or burning', async () => {
		vi.mocked(evm.evmDepositForBurn).mockClear();
		vi.mocked(evm.approveEvmUsdc).mockClear();
		await expect(
			runTransfer(record({ sender: OTHER_EVM }), {
				dAppKit: suiDAppKit().dAppKit,
				wallets: evmWallets(),
				iris: noIris(),
				chains,
				onUpdate: () => undefined,
			}),
		).rejects.toThrow(
			'This transfer was started from 0x1111…1111 on Ethereum. Connect that wallet to continue.',
		);
		expect(evm.approveEvmUsdc).not.toHaveBeenCalled();
		expect(evm.evmDepositForBurn).not.toHaveBeenCalled();
	});

	it('accepts the same EVM account whatever the letter case', async () => {
		vi.mocked(evm.evmDepositForBurn).mockClear();
		vi.mocked(evm.waitForEvmReceipt).mockImplementation(async (_chain, hash) => hash);
		const attested = {
			status: 'complete',
			message: message(0n),
			attestation: `0x${'bb'.repeat(65)}`,
		};
		const result = await runTransfer(record({ sender: EVM_ADDRESS.toLowerCase() }), {
			dAppKit: suiDAppKit().dAppKit,
			wallets: evmWallets(),
			iris: new IrisClient('mainnet', {
				fetch: vi.fn<typeof fetch>(async () => json(200, { messages: [attested] })),
			}),
			chains,
			stopAfterAttestation: true,
			pollIntervalMs: 1,
			onUpdate: () => undefined,
		});
		expect(result.sourceTxHash).toBe(BURN_HASH);
		expect(evm.evmDepositForBurn).toHaveBeenCalledTimes(1);
	});

	it('refuses a Solana burn from another account', async () => {
		solanaAcceptsEverything();
		solanaWalletHolds(5_000_000n);
		const started = Keypair.generate().publicKey.toBase58();
		const connected = Keypair.generate().publicKey.toBase58();
		const signAndSendTransaction = vi.fn<SendSolana>();
		await expect(
			runTransfer(record({ from: 'solana', sender: started }), {
				dAppKit: suiDAppKit().dAppKit,
				wallets: solanaWallets(connected, signAndSendTransaction),
				iris: noIris(),
				chains,
				onUpdate: () => undefined,
			}),
		).rejects.toThrow(/This transfer was started from .* on Solana\. Connect that wallet/);
		expect(signAndSendTransaction).not.toHaveBeenCalled();
	});

	it('refuses a Sui burn when another Sui account, or none, is connected', async () => {
		for (const account of [`0x${'ee'.repeat(32)}`, null]) {
			const { dAppKit, signAndExecuteTransaction } = suiDAppKit({ account });
			await expect(
				runTransfer(
					record({ from: 'sui', to: 'ethereum', sender: SUI_ADDRESS, recipient: EVM_ADDRESS }),
					{
						dAppKit,
						wallets: evmWallets(),
						iris: noIris(),
						chains,
						onUpdate: () => undefined,
					},
				),
			).rejects.toThrow(/This transfer was started from 0xcdcd…cdcd on Sui\. Connect that wallet/);
			expect(signAndExecuteTransaction).not.toHaveBeenCalled();
		}
	});
});

describe('a kit that is torn down while an approval is pending', () => {
	it('does not go on to ask for the burn', async () => {
		vi.mocked(evm.evmDepositForBurn).mockClear();
		vi.mocked(evm.getEvmUsdcAllowance).mockResolvedValueOnce(0n);
		const controller = new AbortController();
		// The approval is mined after the host has destroyed the kit.
		vi.mocked(evm.approveEvmUsdc).mockImplementationOnce(async () => {
			controller.abort(new Error('destroyed'));
			return BURN_HASH;
		});
		const updates: TransferRecord[] = [];
		await expect(
			runTransfer(record({}), {
				dAppKit: suiDAppKit().dAppKit,
				wallets: evmWallets(),
				iris: new IrisClient('mainnet', { fetch: vi.fn<typeof fetch>() }),
				chains,
				signal: controller.signal,
				onUpdate: (t) => updates.push(t),
			}),
		).rejects.toThrow('destroyed');
		expect(evm.evmDepositForBurn).not.toHaveBeenCalled();
		// Aborted, not failed: the record is left as it was for whoever resumes it.
		expect(updates.map((u) => u.status)).toEqual(['approving']);
	});
});

describe('a claim on Sui', () => {
	const claimable = () =>
		record({
			status: 'readyToMint',
			sourceTxHash: BURN_HASH,
			message: message(BigInt(Date.now() + 3_600_000)),
			attestation: `0x${'11'.repeat(65)}`,
		});
	const context = (dAppKit: AnyDAppKit, updates: TransferRecord[] = []) => ({
		dAppKit,
		wallets: evmWallets(),
		iris: new IrisClient('mainnet', { fetch: vi.fn<typeof fetch>() }),
		chains,
		onUpdate: (t: TransferRecord) => updates.push(t),
	});
	/** What the transmitter's `is_nonce_used` view returns, as a simulation result. */
	const nonceIs = (used: boolean) =>
		vi.fn(async () => ({
			commandResults: [{ returnValues: [{ bcs: new Uint8Array([used ? 1 : 0]) }] }],
		}));

	it('keeps its digest when the wait that follows fails', async () => {
		// The message is spent once the claim executes. Losing the digest here left a transfer
		// that could only ever fail: every later claim met a nonce that was already used.
		const { dAppKit } = suiDAppKit({
			core: { waitForTransaction: vi.fn(async () => Promise.reject(new Error('node says no'))) },
		});
		const updates: TransferRecord[] = [];
		const result = await runTransfer(claimable(), context(dAppKit, updates));
		expect(result).toMatchObject({ status: 'complete', destinationTxHash: SUI_DIGEST });
		// Recorded while the claim was still in progress, not only at the end.
		expect(updates.find((u) => u.destinationTxHash)?.status).toBe('minting');
	});

	it('is not sent again when the chain says the message was already claimed', async () => {
		const { dAppKit, signAndExecuteTransaction } = suiDAppKit({
			core: { simulateTransaction: nonceIs(true) },
		});
		const result = await runTransfer(claimable(), context(dAppKit));
		expect(result.status).toBe('complete');
		expect(signAndExecuteTransaction).not.toHaveBeenCalled();
	});

	it('is sent when the message has not been claimed, or the lookup cannot be made', async () => {
		for (const simulateTransaction of [
			nonceIs(false),
			vi.fn(async () => Promise.reject(new Error('no'))),
		]) {
			const { dAppKit, signAndExecuteTransaction } = suiDAppKit({ core: { simulateTransaction } });
			const result = await runTransfer(claimable(), context(dAppKit));
			expect(result.status).toBe('complete');
			expect(signAndExecuteTransaction).toHaveBeenCalledTimes(1);
		}
	});
});

describe('a burn that was sent but not yet seen on its chain', () => {
	const circleKnowsNothing = () =>
		new IrisClient('mainnet', {
			fetch: vi.fn<typeof fetch>(async () => json(404, { error: 'not found' })),
		});
	const circleAttests = () =>
		new IrisClient('mainnet', {
			fetch: vi.fn<typeof fetch>(async () =>
				json(200, {
					messages: [
						{ status: 'complete', message: message(0n), attestation: `0x${'bb'.repeat(65)}` },
					],
				}),
			),
		});
	/** As a reload leaves it: the hash is recorded, the chain was never heard from. */
	const sentNotConfirmed = (over: Partial<TransferRecord> = {}) =>
		record({ status: 'burning', sourceTxHash: BURN_HASH, ...over });
	const context = (iris: IrisClient, updates: TransferRecord[] = []) => ({
		dAppKit: suiDAppKit().dAppKit,
		wallets: evmWallets(),
		iris,
		chains,
		// What resuming on load passes: it must not need the user's wallet.
		stopAfterAttestation: true,
		pollIntervalMs: 1,
		confirmRetryMs: 1,
		onUpdate: (t: TransferRecord) => updates.push(t),
	});

	it('is checked again after a reload, and released when it was cancelled or reverted', async () => {
		// Without this the transfer went straight to waiting for Circle, for a hash Circle will
		// never know.
		vi.mocked(evm.evmDepositForBurn).mockClear();
		vi.mocked(evm.waitForEvmReceipt).mockRejectedValue(
			new TransactionRevertedError('Transaction was cancelled in the wallet'),
		);
		const updates: TransferRecord[] = [];
		await expect(
			runTransfer(sentNotConfirmed(), context(circleKnowsNothing(), updates)),
		).rejects.toThrow(/cancelled in the wallet/);
		expect(updates.at(-1)!.status).toBe('failed');
		expect(updates.at(-1)!.sourceTxHash).toBeUndefined();
		expect(evm.evmDepositForBurn).not.toHaveBeenCalled();
	});

	it('stays "burning" until the chain shows it, then waits for Circle', async () => {
		vi.mocked(evm.waitForEvmReceipt).mockImplementation(async (_chain, hash) => hash);
		const updates: TransferRecord[] = [];
		const result = await runTransfer(sentNotConfirmed(), context(circleAttests(), updates));
		expect(result.status).toBe('readyToMint');
		expect(result.sourceConfirmed).toBe(true);
		expect(result.burnedAt).toBeTypeOf('number');
		expect(updates.every((u) => u.sourceTxHash === BURN_HASH)).toBe(true);
	});

	it('keeps asking the chain while it cannot say, and is not given up meanwhile', async () => {
		vi.mocked(evm.waitForEvmReceipt)
			.mockReset()
			.mockRejectedValueOnce(new Error('Timed out while waiting for transaction to be confirmed'))
			.mockRejectedValueOnce(new Error('HTTP request failed'))
			.mockRejectedValue(new TransactionRevertedError('Transaction reverted on Ethereum'));
		const updates: TransferRecord[] = [];
		await expect(
			runTransfer(sentNotConfirmed(), context(circleKnowsNothing(), updates)),
		).rejects.toThrow(/reverted/);
		expect(evm.waitForEvmReceipt).toHaveBeenCalledTimes(3);
		// The hash was only dropped by the answer that ruled the burn out.
		const dropped = updates.findIndex((u) => !u.sourceTxHash);
		expect(dropped).toBe(updates.length - 2);
		// Meanwhile it was shown as waiting for Circle, not held at "burning": the form is free.
		expect(updates.slice(0, dropped).some((u) => u.status === 'attesting' && !u.burnedAt)).toBe(
			true,
		);
		vi.mocked(evm.waitForEvmReceipt)
			.mockReset()
			.mockImplementation(async (_chain, hash) => hash);
	});

	it('counts as seen once Circle attests it, whatever the chain could say', async () => {
		vi.mocked(evm.waitForEvmReceipt).mockRejectedValue(new Error('HTTP request failed'));
		const result = await runTransfer(sentNotConfirmed(), context(circleAttests()));
		expect(result).toMatchObject({
			status: 'readyToMint',
			sourceTxHash: BURN_HASH,
			sourceConfirmed: true,
		});
		expect(result.burnedAt).toBeTypeOf('number');
		vi.mocked(evm.waitForEvmReceipt)
			.mockReset()
			.mockImplementation(async (_chain, hash) => hash);
	});

	it('is not asked about again once the chain has shown it', async () => {
		vi.mocked(evm.waitForEvmReceipt).mockClear();
		const result = await runTransfer(
			sentNotConfirmed({ status: 'attesting', sourceConfirmed: true, burnedAt: 5 }),
			context(circleAttests()),
		);
		expect(result.status).toBe('readyToMint');
		expect(evm.waitForEvmReceipt).not.toHaveBeenCalled();
	});

	it('is still checked when all that vouches for it is a time an earlier version stamped', async () => {
		// That version stamped `burnedAt` once a burn was sent, whatever became of it. Taking
		// the time as proof left a burn that had reverted waiting for Circle for good.
		vi.mocked(evm.waitForEvmReceipt)
			.mockReset()
			.mockRejectedValue(new TransactionRevertedError('Transaction reverted on Ethereum'));
		const updates: TransferRecord[] = [];
		await expect(
			runTransfer(
				sentNotConfirmed({ status: 'attesting', burnedAt: 5, attestingSince: 5 }),
				context(circleKnowsNothing(), updates),
			),
		).rejects.toThrow(/reverted/);
		expect(updates.at(-1)!.status).toBe('failed');
		expect(updates.at(-1)!.sourceTxHash).toBeUndefined();
		// Nothing was burned, so there is no burn time left to count a wait from.
		expect(updates.at(-1)!.burnedAt).toBeUndefined();

		// Such a record whose burn did happen keeps its time and is not asked about again.
		vi.mocked(evm.waitForEvmReceipt)
			.mockReset()
			.mockImplementation(async (_chain, hash) => hash);
		const result = await runTransfer(
			sentNotConfirmed({ status: 'attesting', burnedAt: 5, attestingSince: 5 }),
			context(circleAttests()),
		);
		expect(result).toMatchObject({ status: 'readyToMint', sourceConfirmed: true, burnedAt: 5 });
		expect(evm.waitForEvmReceipt).toHaveBeenCalledTimes(1);
	});

	it('on Solana, is released at once when the chain is already past its last block', async () => {
		// The bound recorded when it was sent lets a later session rule it out without waiting.
		solanaChainIs({ finalized: 5_000 });
		solanaSays(null);
		const owner = Keypair.generate().publicKey.toBase58();
		const updates: TransferRecord[] = [];
		await expect(
			runTransfer(
				sentNotConfirmed({
					from: 'solana',
					sender: owner,
					sourceTxHash: 'sent-signature',
					sourceTxLastBlock: 1_300,
				}),
				{ ...context(circleKnowsNothing(), updates), wallets: solanaWallets(owner, vi.fn()) },
			),
		).rejects.toThrow(/expired before it was included/);
		expect(updates.at(-1)).toMatchObject({
			status: 'failed',
			droppedSourceTxHash: 'sent-signature',
		});
		expect(updates.at(-1)!.sourceTxHash).toBeUndefined();
	});

	it('on Solana, is not written off for being unknown when nothing says when it was sent', async () => {
		// A record from an earlier version: a time, no last block. The chain is far past any
		// bound taken now, and the node does not know the burn. That is what a node that keeps
		// little history says about a burn that went through long ago.
		solanaChainIs({ finalized: 5_000 });
		solanaSays(null);
		const owner = Keypair.generate().publicKey.toBase58();
		const updates: TransferRecord[] = [];
		const stop = new AbortController();
		const outcome = runTransfer(
			sentNotConfirmed({
				from: 'solana',
				sender: owner,
				sourceTxHash: 'sent-signature',
				status: 'attesting',
				burnedAt: 5,
			}),
			{
				...context(circleKnowsNothing(), updates),
				wallets: solanaWallets(owner, vi.fn()),
				signal: stop.signal,
			},
		).catch((error: Error) => error);
		await new Promise((resolve) => setTimeout(resolve, 60));
		stop.abort(new Error('stopped by the test'));
		expect(((await outcome) as Error).message).toBe('stopped by the test');
		expect(updates.every((u) => u.sourceTxHash === 'sent-signature')).toBe(true);
		expect(updates.some((u) => u.status === 'failed')).toBe(false);

		// Found on chain with an error, it is released like any other: that is evidence.
		solanaSays({ err: { InstructionError: [0, { Custom: 1 }] }, confirmationStatus: 'finalized' });
		const released: TransferRecord[] = [];
		await expect(
			runTransfer(
				sentNotConfirmed({
					from: 'solana',
					sender: owner,
					sourceTxHash: 'sent-signature',
					status: 'attesting',
					burnedAt: 5,
				}),
				{ ...context(circleKnowsNothing(), released), wallets: solanaWallets(owner, vi.fn()) },
			),
		).rejects.toThrow(/failed/);
		expect(released.at(-1)!.sourceTxHash).toBeUndefined();
	});

	it('on Solana, records the last block that can carry it when it is sent', async () => {
		solanaAcceptsEverything();
		solanaWalletHolds(5_000_000n);
		const owner = Keypair.generate().publicKey.toBase58();
		const result = await runTransfer(record({ from: 'solana', sender: owner }), {
			...context(circleAttests()),
			wallets: solanaWallets(owner, async () => 'solana-signature'),
		});
		// The chain was at block 1000: 150 for the blockhash, 150 for not knowing which one.
		expect(result.sourceTxLastBlock).toBe(1_300);
	});
});
