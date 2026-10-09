// Copyright (c) Mysten Labs, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { DAppKit } from '@mysten/dapp-kit-core';
import type { ChainFilter, ChainIconOverrides, Direction, RpcOverrides } from '../chains/index.js';
import type { ChainDefinition, ChainKey, Network } from '../chains/types.js';
import type { IrisClientOptions } from '../iris/client.js';
import type { StateStorage } from '../utils/storage.js';
import type { EvmWalletAdapter, SolanaWalletAdapter, WalletAdapters } from '../wallets/types.js';

export type TransferSpeed = 'fast' | 'standard';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyDAppKit = DAppKit<any, any>;

/**
 * Supplies the EVM and Solana wallets, loaded the first time one is needed. The ready-made one is
 * `appKitWallets()` from `@mysten-incubation/cctp-kit/appkit`.
 */
export type WalletLayer = (context: {
	network: Network;
	chains: ChainDefinition[];
}) => Promise<WalletAdapters>;

export interface CctpKitWalletConfig {
	/** The host's existing EVM connection (e.g. `createEvmWalletFromWagmiConfig(config)`). */
	evm?: EvmWalletAdapter;
	/** The host's existing Solana connection. */
	solana?: SolanaWalletAdapter;
	/**
	 * Supplies whichever of the two is not given above. It lives behind its own entry point so
	 * that a host which brings its own wallets does not have to install, or bundle, the packages
	 * the ready-made one is built on. Without it, and without an adapter, that ecosystem's
	 * chains are listed but cannot be connected.
	 */
	layer?: WalletLayer;
}

export interface CctpKitConfig {
	/** The host app's dapp-kit instance; the widget never mounts its own Sui wallet connection. */
	dAppKit: AnyDAppKit;
	/**
	 * Which Circle environment to use. Defaults to `mainnet` when dapp-kit's current network is
	 * `mainnet`, otherwise `testnet`.
	 */
	network?: Network;
	/** `both` (default), `inflow` (everything lands on Sui) or `outflow` (everything leaves Sui). */
	direction?: Direction;
	/** Restrict selectable chains globally or per side. */
	chains?: ChainFilter;
	transferSpeed?: {
		default?: TransferSpeed;
		/** Speeds the user may pick. Defaults to both. */
		allow?: TransferSpeed[];
	};
	/** Override or extend the built-in public RPC endpoints for non-Sui chains. */
	rpc?: RpcOverrides;
	/** Override chain icons (URL or data URI); `null` renders a text monogram instead. */
	icons?: ChainIconOverrides;
	wallets?: CctpKitWalletConfig;
	iris?: IrisClientOptions;
	defaults?: {
		from?: ChainKey;
		to?: ChainKey;
		/** Human-readable USDC amount, e.g. "25". */
		amount?: string;
	};
	/** Persist in-flight transfers so they can be resumed after a reload. `null` disables. */
	storage?: StateStorage | null;
	storageKey?: string;
	onEvent?: (event: CctpKitEvent) => void;
	ui?: {
		/** Heading shown at the top of the widget. Defaults to "Bridge USDC". */
		title?: string;
	};
}

export type TransferStatus =
	| 'pending'
	| 'approving'
	| 'burning'
	| 'attesting'
	| 'readyToMint'
	| 'minting'
	| 'complete'
	| 'failed';

export interface TransferRecord {
	id: string;
	network: Network;
	from: ChainKey;
	to: ChainKey;
	/** Base units (6 decimals). */
	amount: string;
	/** Base units. */
	maxFee: string;
	speed: TransferSpeed;
	/** Source address that burned. */
	sender: string;
	/** Destination address in the destination chain's native format. */
	recipient: string;
	status: TransferStatus;
	sourceTxHash?: string;
	/**
	 * A Solana burn that the chain has ruled out: it failed, or it can no longer be included.
	 * It is looked up once more before the transfer burns again.
	 */
	droppedSourceTxHash?: string;
	/**
	 * For a Solana burn: the last block that could include `sourceTxHash`. Kept so that a
	 * transfer resumed later can tell a burn that is still on its way from one that is gone.
	 */
	sourceTxLastBlock?: number;
	message?: string;
	attestation?: string;
	destinationTxHash?: string;
	error?: string;
	createdAt: number;
	updatedAt: number;
	/**
	 * The burn is known to have happened: its chain showed it succeeding, or Circle has it. Until
	 * this is set the burn has only been sent, and the transfer keeps checking its chain for it.
	 */
	sourceConfirmed?: boolean;
	/**
	 * When the burn happened, as near as is known. It is where the wait is counted from on
	 * screen and proves nothing: earlier versions stamped it when a burn was sent.
	 */
	burnedAt?: number;
	/** When the attestation wait started (first time the status became `attesting`). */
	attestingSince?: number;
	/** When the transfer completed. */
	completedAt?: number;
	/** Archived by the user (Dismiss). Kept in storage and visible in history; not in the pending list. */
	hidden?: boolean;
}

export type CctpKitEvent =
	| { type: 'transfer:updated'; transfer: TransferRecord }
	| { type: 'transfer:complete'; transfer: TransferRecord }
	| { type: 'transfer:failed'; transfer: TransferRecord; error: unknown }
	| { type: 'wallet:connected'; ecosystem: 'evm' | 'solana' | 'sui'; address: string }
	| { type: 'wallet:disconnected'; ecosystem: 'evm' | 'solana' | 'sui' };

export interface Quote {
	/** Route the quote was computed for; a quote for a different route or amount is stale. */
	from: ChainKey;
	to: ChainKey;
	speed: TransferSpeed;
	amount: bigint;
	/** Circle's fee in basis points for the chosen finality tier (0 when not quoted). */
	feeBps: number;
	/** Fee in base units, rounded up. */
	fee: bigint;
	/** `maxFee` to pass to `depositForBurn`. */
	maxFee: bigint;
	minFinalityThreshold: number;
	/** Amount the recipient should receive. */
	receiveAmount: bigint;
	/** Whether Circle returned a quote for this route or we fell back to standard, zero-fee. */
	quoted: boolean;
	/** Expected wait for Circle's attestation, in seconds, before the destination mint. */
	estimate: { minSeconds: number; maxSeconds: number };
}
