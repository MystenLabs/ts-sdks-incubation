// Copyright (c) Mysten Labs, Inc.
// SPDX-License-Identifier: Apache-2.0

export { createCctpKit, estimateFor } from './core/index.js';
export type { CctpKit } from './core/index.js';
export type { CctpKitStores, WalletState, BalanceState } from './core/store.js';
export type {
	AnyDAppKit,
	CctpKitConfig,
	CctpKitEvent,
	CctpKitWalletConfig,
	WalletLayer,
	Quote,
	TransferRecord,
	TransferSpeed,
	TransferStatus,
} from './core/types.js';
export { mintRecipientBytes, runTransfer } from './core/transfer.js';
export {
	classifyTxHash,
	parseTxReference,
	resolveSourceChain,
	buildImportedRecord,
	burnDetailsFromIris,
} from './core/import.js';
export type { BurnDetails, HashKind } from './core/import.js';
export type { TransferContext } from './core/transfer.js';

export * from './chains/index.js';

export { IrisClient, IrisError, IRIS_BASE_URL, isAttested } from './iris/client.js';
export {
	CctpKitError,
	describeError,
	TransactionRevertedError,
	WalletNetworkError,
} from './utils/errors.js';
export type {
	IrisClientOptions,
	IrisDecodedMessage,
	IrisDecodedMessageBody,
	IrisFeeTier,
	IrisMessage,
	IrisMessagesResponse,
} from './iris/client.js';

export * from './engine/evm.js';
export * from './engine/sui.js';
export * from './engine/solana.js';

export { createEvmWalletFromWagmiConfig } from './wallets/wagmi.js';
export type { WagmiEvmWalletOptions } from './wallets/wagmi.js';
export { signAndSendSolanaTransaction } from './wallets/solana.js';
export type { SolanaProviderLike } from './wallets/solana.js';
export type {
	EvmWalletAdapter,
	SolanaWalletAdapter,
	WalletAccount,
	WalletAdapters,
} from './wallets/types.js';

export { parseUsdc, formatUsdc, feeFromBps } from './utils/amount.js';
export { formatDuration, formatElapsed, waitProgress } from './utils/duration.js';
export type { WaitProgress } from './utils/duration.js';
export {
	bytesToHex,
	hexToBytes,
	toBytes32,
	fromBytes32,
	isValidAddress,
	parseMessageV2,
	MESSAGE_V2,
} from './utils/bytes.js';
export type { Hex, ParsedMessageV2 } from './utils/bytes.js';
export { createInMemoryStorage, getDefaultStorage, DEFAULT_STORAGE_KEY } from './utils/storage.js';
export type { StateStorage } from './utils/storage.js';
