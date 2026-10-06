// Copyright (c) Mysten Labs, Inc.
// SPDX-License-Identifier: Apache-2.0

import { atom, computed, map } from 'nanostores';
import type { MapStore, ReadableAtom, WritableAtom } from 'nanostores';
import { counterpartOptionsFor, destinationsFor, findChain, suiSideFor } from '../chains/index.js';
import type { ResolvedRoutes } from '../chains/index.js';
import type { ChainDefinition, ChainKey } from '../chains/types.js';
import type { WalletAccount } from '../wallets/types.js';
import type { Quote, TransferRecord, TransferSpeed } from './types.js';

export interface WalletState {
	sui: WalletAccount | null;
	evm: WalletAccount | null;
	solana: WalletAccount | null;
	/** True once the default wallet layer has finished loading. */
	ready: boolean;
}

export interface BalanceState {
	/** Base units, or null while loading / unknown. */
	source: bigint | null;
}

export interface CctpKitStores {
	$routes: WritableAtom<ResolvedRoutes>;
	$fromChain: WritableAtom<ChainKey>;
	$toChain: WritableAtom<ChainKey>;
	$amount: WritableAtom<string>;
	$speed: WritableAtom<TransferSpeed>;
	/** Explicit recipient override; empty string means "the connected destination wallet". */
	$recipient: WritableAtom<string>;
	$wallets: MapStore<WalletState>;
	$balance: MapStore<BalanceState>;
	$quote: WritableAtom<Quote | null>;
	$quoteError: WritableAtom<string | null>;
	/** Whether Fast Transfer can be offered for the current route; null while unknown. */
	$fastAvailable: WritableAtom<boolean | null>;
	/** Human-readable reason when `$fastAvailable` is false. */
	$fastUnavailableReason: WritableAtom<string | null>;
	/** Every record stored for this network in this browser, whoever made it. */
	$transfers: WritableAtom<TransferRecord[]>;
	/**
	 * Transfers looked up by transaction hash in this session. They stay listed whichever
	 * wallet is connected, until the page reloads.
	 */
	$trackedTransferIds: WritableAtom<ReadonlySet<string>>;
	/**
	 * The transfers the widget lists. One that is still in progress is always included,
	 * whoever made it: this record is the only way back to a burn that is waiting to be
	 * claimed. A completed one is included only when a connected wallet sent or received it.
	 */
	$history: ReadableAtom<TransferRecord[]>;
	$activeTransferId: WritableAtom<string | null>;
	$activeTransfer: ReadableAtom<TransferRecord | null>;
	$sourceChain: ReadableAtom<ChainDefinition>;
	$destinationChain: ReadableAtom<ChainDefinition>;
	$destinationOptions: ReadableAtom<ChainDefinition[]>;
	/** Which side of the form Sui is on. */
	$suiSide: ReadableAtom<'from' | 'to'>;
	/** The selected non-Sui chain. */
	$counterpartChain: ReadableAtom<ChainDefinition>;
	/** Non-Sui chains selectable for the current orientation. */
	$counterpartOptions: ReadableAtom<ChainDefinition[]>;
	$sourceAccount: ReadableAtom<WalletAccount | null>;
	$destinationAccount: ReadableAtom<WalletAccount | null>;
}

/** Hex addresses (EVM, Sui) compare case-insensitively; Solana's base58 is case-sensitive. */
const addressKey = (address: string | undefined) =>
	address?.startsWith('0x') ? address.toLowerCase() : (address ?? '');

/** Whether one of the connected wallets sent or received the transfer. */
export function involvesConnectedWallet(transfer: TransferRecord, wallets: WalletState): boolean {
	const connected = [wallets.sui, wallets.evm, wallets.solana]
		.filter((account): account is WalletAccount => account !== null)
		.map((account) => addressKey(account.address));
	return (
		connected.includes(addressKey(transfer.sender)) ||
		connected.includes(addressKey(transfer.recipient))
	);
}

export function createStores(args: {
	routes: ResolvedRoutes;
	from: ChainKey;
	to: ChainKey;
	amount: string;
	speed: TransferSpeed;
}): CctpKitStores {
	const $routes = atom<ResolvedRoutes>(args.routes);
	const $fromChain = atom<ChainKey>(args.from);
	const $toChain = atom<ChainKey>(args.to);
	const $amount = atom<string>(args.amount);
	const $speed = atom<TransferSpeed>(args.speed);
	const $recipient = atom<string>('');
	const $wallets: MapStore<WalletState> = map<WalletState>({
		sui: null,
		evm: null,
		solana: null,
		ready: false,
	});
	const $balance: MapStore<BalanceState> = map<BalanceState>({ source: null });
	const $quote = atom<Quote | null>(null);
	const $quoteError = atom<string | null>(null);
	const $fastAvailable = atom<boolean | null>(null);
	const $fastUnavailableReason = atom<string | null>(null);
	const $transfers = atom<TransferRecord[]>([]);
	const $trackedTransferIds = atom<ReadonlySet<string>>(new Set());
	const $history = computed(
		[$transfers, $wallets, $trackedTransferIds],
		(transfers, wallets, tracked) =>
			transfers.filter(
				(t) => t.status !== 'complete' || tracked.has(t.id) || involvesConnectedWallet(t, wallets),
			),
	);
	const $activeTransferId = atom<string | null>(null);

	const allChains = computed($routes, (routes) => {
		const seen = new Map<ChainKey, ChainDefinition>();
		for (const c of [...routes.from, ...routes.to]) seen.set(c.key, c);
		return [...seen.values()];
	});

	const $sourceChain = computed([allChains, $fromChain], (chains, key) => findChain(chains, key));
	const $destinationChain = computed([allChains, $toChain], (chains, key) =>
		findChain(chains, key),
	);
	const $destinationOptions = computed([$routes, $fromChain], (routes, from) =>
		destinationsFor(routes, from),
	);

	const $suiSide = computed($fromChain, (from) => suiSideFor(from));
	const $counterpartChain = computed([$sourceChain, $destinationChain], (from, to) =>
		from.ecosystem === 'sui' ? to : from,
	);
	const $counterpartOptions = computed([$routes, $fromChain], (routes, from) =>
		counterpartOptionsFor(routes, from),
	);

	const accountFor = (chain: ChainDefinition, wallets: WalletState) => wallets[chain.ecosystem];
	const $sourceAccount = computed([$sourceChain, $wallets], accountFor);
	const $destinationAccount = computed([$destinationChain, $wallets], accountFor);

	const $activeTransfer = computed([$transfers, $activeTransferId], (transfers, id) =>
		id ? (transfers.find((t) => t.id === id) ?? null) : null,
	);

	return {
		$routes,
		$fromChain,
		$toChain,
		$amount,
		$speed,
		$recipient,
		$wallets,
		$balance,
		$quote,
		$quoteError,
		$fastAvailable,
		$fastUnavailableReason,
		$transfers,
		$trackedTransferIds,
		$history,
		$activeTransferId,
		$activeTransfer,
		$sourceChain,
		$destinationChain,
		$destinationOptions,
		$suiSide,
		$counterpartChain,
		$counterpartOptions,
		$sourceAccount,
		$destinationAccount,
	};
}
