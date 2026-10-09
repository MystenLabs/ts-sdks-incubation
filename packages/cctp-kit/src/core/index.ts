// Copyright (c) Mysten Labs, Inc.
// SPDX-License-Identifier: Apache-2.0

import { PublicKey } from '@solana/web3.js';
import {
	applyChainIcons,
	applyRpcOverrides,
	destinationsFor,
	findChain,
	getChainRegistry,
	resolveRoutes,
} from '../chains/index.js';
import type { ResolvedRoutes } from '../chains/index.js';
import { FINALITY_THRESHOLD } from '../chains/types.js';
import type { ChainDefinition, ChainKey, Network, SuiChainDefinition } from '../chains/types.js';
import {
	getEvmBurnDetails,
	getEvmNativeBalance,
	getEvmTransactionTime,
	getEvmUsdcBalance,
} from '../engine/evm.js';
import {
	describeSolanaAccount,
	getSolanaNativeBalance,
	getSolanaTokenAccountOwner,
	getSolanaTransactionTime,
	getSolanaUsdcBalance,
} from '../engine/solana.js';
import { getSuiGasBalance, getSuiTransactionTime, getSuiUsdcBalance } from '../engine/sui.js';
import { IrisClient, IrisError } from '../iris/client.js';
import type { IrisMessage } from '../iris/client.js';
import { feeFromBps, parseUsdc } from '../utils/amount.js';
import { hexToBytes, isValidAddress, normalizeAddress } from '../utils/bytes.js';
import { gasCoin } from '../utils/errors.js';
import { sleep } from '../utils/sleep.js';
import { DEFAULT_STORAGE_KEY, getDefaultStorage } from '../utils/storage.js';
import type { StateStorage } from '../utils/storage.js';
import type {
	EvmWalletAdapter,
	SolanaWalletAdapter,
	WalletAccount,
	WalletAdapters,
} from '../wallets/types.js';
import {
	buildImportedRecord,
	burnDetailsFromIris,
	parseTxReference,
	resolveSourceChain,
} from './import.js';
import type { BurnDetails } from './import.js';
import { createStores } from './store.js';
import type { CctpKitStores } from './store.js';
import { runTransfer } from './transfer.js';
import type { CctpKitConfig, CctpKitEvent, Quote, TransferRecord, TransferSpeed } from './types.js';

export interface CctpKit {
	readonly config: CctpKitConfig;
	readonly network: Network;
	readonly chains: ChainDefinition[];
	readonly routes: ResolvedRoutes;
	readonly allowedSpeeds: TransferSpeed[];
	readonly stores: CctpKitStores;
	readonly iris: IrisClient;
	/** Lazily loads the non-Sui wallet layer (AppKit unless the host injected adapters). */
	wallets(): Promise<WalletAdapters>;
	setFromChain(key: ChainKey): void;
	setToChain(key: ChainKey): void;
	/** Pick the non-Sui chain for whichever side it currently occupies. */
	setCounterpartChain(key: ChainKey): void;
	flipDirection(): void;
	setAmount(value: string): void;
	setSpeed(speed: TransferSpeed): void;
	setRecipient(address: string): void;
	connect(ecosystem: 'evm' | 'solana'): Promise<void>;
	disconnect(ecosystem: 'evm' | 'solana'): Promise<void>;
	refreshBalance(): Promise<void>;
	refreshQuote(): Promise<Quote | null>;
	/** Validate the current form; returns a user-facing reason or null when ready. */
	validate(): string | null;
	/**
	 * What someone should know before burning, about the claim that follows on the destination.
	 * These do not stop a transfer: `validate` is what stops one.
	 */
	warnings(): string[];
	/** Start a new transfer from the current form state. */
	transfer(): Promise<TransferRecord>;
	/** Resume a persisted transfer (e.g. after a reload, or to retry a failed mint). */
	resume(id: string): Promise<TransferRecord>;
	/**
	 * Track a transfer that was not started here (another device, a dismissed card, a burn made
	 * elsewhere) from its source transaction hash. Sui digests and Solana signatures are
	 * recognised by shape; EVM hashes need `sourceChain`. The record is persisted and driven
	 * up to Claim like any other.
	 */
	importTransfer(input: { txHash: string; sourceChain?: ChainKey }): Promise<TransferRecord>;
	/** Whether a transfer is currently being driven (by this kit or another one sharing its storage). */
	isRunning(id: string): boolean;
	/** Archive a transfer: hidden from the pending list, kept in storage and history, still driven if in flight. */
	dismiss(id: string): void;
	/** Bring an archived transfer back into the pending list. */
	restore(id: string): void;
	/** Permanently delete a record. The on-chain transfer is unaffected and can be tracked again by hash. */
	remove(id: string): void;
	/**
	 * Delete a transfer only if it never burned. This is decided from what is stored now, not
	 * from the list a page is showing, which another tab may have left behind. Returns false,
	 * and reloads the list from storage, when the stored record has a burn or is being driven.
	 */
	removeUnburned(id: string): boolean;
	destroy(): void;
}

/**
 * Transfers being driven right now, shared by every kit on the page so two kits with the same
 * storage never run the same transfer twice. Keyed by storage key + record id.
 */
const RUNNING = new Set<string>();

/**
 * This page, as other tabs see it. A tab that drives a transfer says so in the shared storage,
 * so that a second tab does not offer to retry a burn the first one is in the middle of. The
 * claim lapses on its own if the tab dies without releasing it.
 */
const PAGE_ID = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
const LEASE_MS = 90_000;
// Short enough that a background tab, whose timers may fire only once a minute, keeps its claim.
const LEASE_RENEW_MS = 20_000;

const QUOTE_PENDING = 'Fetching quote…';

/** Stands in for a wallet the host did not configure: nothing is connected, and asking says why. */
function missingWallet<E extends 'evm' | 'solana'>(ecosystem: E): WalletAdapters[E] {
	const fail = async (): Promise<never> => {
		throw new Error(
			`No ${ecosystem === 'evm' ? 'EVM' : 'Solana'} wallet is configured. Pass \`wallets: { layer: appKitWallets() }\` from '@mysten-incubation/cctp-kit/appkit', or an adapter of your own.`,
		);
	};
	const stub = {
		ecosystem,
		getAccount: () => null,
		subscribe: () => () => undefined,
		connect: fail,
		disconnect: async () => undefined,
		getWalletClient: fail,
		signAndSendTransaction: fail,
	};
	return stub as unknown as WalletAdapters[E];
}

export function createCctpKit(config: CctpKitConfig): CctpKit {
	const dAppKit = config.dAppKit;
	const network: Network =
		config.network ?? (dAppKit.stores.$currentNetwork.get() === 'mainnet' ? 'mainnet' : 'testnet');
	const chains = applyChainIcons(
		applyRpcOverrides(getChainRegistry(network), config.rpc),
		config.icons,
	);
	const suiChain = chains.find((c): c is SuiChainDefinition => c.ecosystem === 'sui')!;
	const direction = config.direction ?? 'both';
	const routes = resolveRoutes(chains, direction, config.chains);
	if (routes.from.length === 0 || routes.to.length === 0) {
		throw new Error('CCTP kit configuration leaves no valid routes');
	}
	const allowedSpeeds = config.transferSpeed?.allow ?? ['fast', 'standard'];
	if (allowedSpeeds.length === 0) throw new Error('transferSpeed.allow must not be empty');
	const iris = new IrisClient(network, config.iris);
	const storage: StateStorage | null =
		config.storage === null ? null : (config.storage ?? getDefaultStorage());
	const storageKey = `${config.storageKey ?? DEFAULT_STORAGE_KEY}:${network}`;
	const runKey = (id: string) => `${storageKey}:${id}`;

	const initialFrom = pickInitialFrom(routes, config.defaults?.from, direction);
	const initialTo = pickInitialTo(routes, initialFrom, config.defaults?.to);
	const initialSpeed = pickInitialSpeed(config.transferSpeed?.default, allowedSpeeds);
	const stores = createStores({
		routes,
		from: initialFrom,
		to: initialTo,
		amount: config.defaults?.amount ?? '',
		speed: initialSpeed,
	});
	/** The speed the user asked for; `$speed` is what the current route can honour. */
	let preferredSpeed: TransferSpeed = initialSpeed;

	// --- Persistence: read-modify-write so kits sharing a storage key never clobber each other.
	function readStored(): TransferRecord[] {
		if (!storage) return stores.$transfers.get();
		try {
			const raw = storage.getItem(storageKey);
			if (!raw) return [];
			const parsed = JSON.parse(raw) as TransferRecord[];
			return Array.isArray(parsed) ? parsed.filter((t) => t && typeof t.id === 'string') : [];
		} catch {
			return [];
		}
	}

	function writeStored(list: TransferRecord[]) {
		stores.$transfers.set(list);
		if (!storage) return;
		try {
			storage.setItem(storageKey, JSON.stringify(list));
		} catch {
			// Storage full or unavailable; keep going in memory.
		}
	}

	stores.$transfers.set(readStored());

	const emit = (event: CctpKitEvent) => config.onEvent?.(event);
	const cleanups: (() => void)[] = [];
	// Another tab of the same site writes to the same storage. Follow it, so a card here does
	// not go on showing a transfer as it was before that tab moved it on.
	if (storage && typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
		const onStorage = (event: StorageEvent) => {
			// The records themselves, or another tab starting or finishing a run.
			if (event.key === storageKey || event.key?.startsWith(`${storageKey}:running:`)) {
				stores.$transfers.set(readStored());
			}
		};
		window.addEventListener('storage', onStorage);
		cleanups.push(() => window.removeEventListener('storage', onStorage));
	}
	const controllers = new Map<string, AbortController>();
	let destroyed = false;

	// --- Which tab is driving a transfer ----------------------------------------------------
	const leaseKey = (id: string) => `${storageKey}:running:${id}`;
	const leases = new Map<string, () => void>();

	/** The page holding a live claim on this transfer, or null. */
	function leaseHolder(id: string): { owner: string; until: number } | null {
		if (!storage) return null;
		try {
			const lease = JSON.parse(storage.getItem(leaseKey(id)) ?? 'null') as {
				owner?: unknown;
				until?: unknown;
			} | null;
			if (typeof lease?.owner !== 'string' || typeof lease.until !== 'number') return null;
			return lease.until > Date.now() ? { owner: lease.owner, until: lease.until } : null;
		} catch {
			return null;
		}
	}

	function runningElsewhere(id: string): boolean {
		const holder = leaseHolder(id);
		return holder !== null && holder.owner !== PAGE_ID;
	}

	/** Claim a transfer for this page until the returned function is called. */
	function takeLease(id: string): () => void {
		if (!storage) return () => undefined;
		const write = () => {
			try {
				storage.setItem(
					leaseKey(id),
					JSON.stringify({ owner: PAGE_ID, until: Date.now() + LEASE_MS }),
				);
			} catch {
				// Storage full or unavailable: this page still knows, other tabs will not.
			}
		};
		write();
		const timer = setInterval(write, LEASE_RENEW_MS);
		(timer as { unref?: () => void }).unref?.();
		const release = () => {
			clearInterval(timer);
			leases.delete(id);
			try {
				if (leaseHolder(id)?.owner === PAGE_ID) storage.removeItem(leaseKey(id));
			} catch {
				// Nothing to do: the claim lapses by itself.
			}
		};
		leases.set(id, release);
		return release;
	}

	// A page that is going away gives its claims up at once, so the page that replaces it (a
	// reload) can carry on without waiting for them to lapse.
	if (storage && typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
		const putAway = (event: PageTransitionEvent) => {
			// A page kept for the back button is frozen, not gone. Brought back, it would carry
			// on with runs whose claims it gave up here, beside whichever tab took them over. So
			// its runs end with its claims.
			if (event.persisted) {
				for (const controller of controllers.values()) controller.abort();
			}
			for (const release of leases.values()) release();
		};
		// Brought back, it starts again the way a page that has just loaded does.
		const broughtBack = (event: PageTransitionEvent) => {
			if (event.persisted && !destroyed) resumeInterrupted();
		};
		window.addEventListener('pagehide', putAway);
		window.addEventListener('pageshow', broughtBack);
		cleanups.push(() => {
			window.removeEventListener('pagehide', putAway);
			window.removeEventListener('pageshow', broughtBack);
		});
	}

	// --- Sui account comes straight from dapp-kit. -------------------------------------
	cleanups.push(
		dAppKit.stores.$connection.subscribe((connection) => {
			const account = connection.account ? { address: connection.account.address } : null;
			const previous = stores.$wallets.get().sui;
			stores.$wallets.setKey('sui', account);
			if (account && account.address !== previous?.address) {
				emit({ type: 'wallet:connected', ecosystem: 'sui', address: account.address });
				void refreshBalance();
			} else if (!account && previous) {
				emit({ type: 'wallet:disconnected', ecosystem: 'sui' });
				stores.$balance.setKey('source', null);
			}
		}),
	);
	// Balance reads depend on the network dapp-kit is on; re-read when it changes.
	cleanups.push(dAppKit.stores.$currentNetwork.subscribe(() => void refreshBalance()));

	// --- Non-Sui wallets: the host's adapters win, otherwise its wallet layer (lazy). ----
	let walletsPromise: Promise<WalletAdapters> | undefined;
	const wallets = () => {
		walletsPromise ??= (async () => {
			const injectedEvm = config.wallets?.evm;
			const injectedSolana = config.wallets?.solana;
			const layer =
				(!injectedEvm || !injectedSolana) && config.wallets?.layer
					? await config.wallets.layer({ network, chains })
					: null;
			const adapters: WalletAdapters = {
				evm: injectedEvm ?? layer?.evm ?? missingWallet('evm'),
				solana: injectedSolana ?? layer?.solana ?? missingWallet('solana'),
			};
			if (!destroyed) {
				bindWallet('evm', adapters.evm);
				bindWallet('solana', adapters.solana);
				stores.$wallets.setKey('ready', true);
			}
			return adapters;
		})();
		return walletsPromise;
	};

	function bindWallet(
		ecosystem: 'evm' | 'solana',
		adapter: EvmWalletAdapter | SolanaWalletAdapter,
	) {
		const apply = (account: WalletAccount | null) => {
			const previous = stores.$wallets.get()[ecosystem];
			stores.$wallets.setKey(ecosystem, account);
			if (account && account.address !== previous?.address) {
				emit({ type: 'wallet:connected', ecosystem, address: account.address });
				void refreshBalance();
			} else if (!account && previous) {
				emit({ type: 'wallet:disconnected', ecosystem });
			}
		};
		apply(adapter.getAccount());
		cleanups.push(adapter.subscribe(apply));
	}

	const needsNonSui = () =>
		stores.$sourceChain.get().ecosystem !== 'sui' ||
		stores.$destinationChain.get().ecosystem !== 'sui';
	if (needsNonSui()) void wallets().catch(() => undefined);

	// --- Balance + quote ----------------------------------------------------------------
	async function refreshBalance() {
		const chain = stores.$sourceChain.get();
		const account = stores.$sourceAccount.get();
		if (!account) {
			stores.$balance.setKey('source', null);
			return;
		}
		try {
			let balance: bigint;
			switch (chain.ecosystem) {
				case 'sui':
					balance = await getSuiUsdcBalance(
						dAppKit.getClient(chain.suiNetwork),
						chain,
						account.address,
					);
					break;
				case 'evm':
					balance = await getEvmUsdcBalance(chain, account.address as `0x${string}`);
					break;
				case 'solana':
					balance = await getSolanaUsdcBalance(chain, new PublicKey(account.address));
					break;
			}
			if (
				stores.$sourceChain.get() === chain &&
				stores.$sourceAccount.get()?.address === account.address
			) {
				stores.$balance.setKey('source', balance);
			}
		} catch {
			// Unknown balance (RPC trouble) must not block the form; validation skips the check.
			stores.$balance.setKey('source', null);
		}
	}

	// --- What the destination will need -------------------------------------------------
	// A transfer ends with a claim on the destination, paid for there. Both people who lost
	// track of funds in production learned that only after their burn, so it is looked at, and
	// said, while the form is being filled in.
	const DESTINATION_CHECK_MS = 6_000;

	async function gasHeldOn(chain: ChainDefinition, address: string): Promise<bigint> {
		switch (chain.ecosystem) {
			case 'sui':
				return getSuiGasBalance(dAppKit.getClient(chain.suiNetwork), address);
			case 'evm':
				return getEvmNativeBalance(chain, address as `0x${string}`);
			case 'solana':
				return getSolanaNativeBalance(chain, new PublicKey(address));
		}
	}

	/** Why a typed recipient cannot be sent to, or null. Only Solana can be told apart on chain. */
	async function recipientProblemOn(
		chain: ChainDefinition,
		address: string,
	): Promise<string | null> {
		if (chain.ecosystem !== 'solana') return null;
		const account = await describeSolanaAccount(chain, new PublicKey(address));
		switch (account.kind) {
			case 'wallet':
				return null;
			case 'tokenAccount':
				return account.mint === chain.usdcMint
					? `That is a USDC token account, not a wallet. Enter the wallet that owns it: ${account.owner}`
					: 'That is a token account for another token, not a wallet address';
			case 'mint':
			case 'program':
				return 'That address is a token or a program, not a wallet';
		}
	}

	let destinationSeq = 0;
	async function refreshDestination() {
		const seq = ++destinationSeq;
		const to = stores.$destinationChain.get();
		const claimer = stores.$destinationAccount.get();
		const typed = stores.$recipient.get();
		stores.$destination.set({ gas: null, recipientProblem: null });
		if (!claimer && !typed) return;
		const giveUp = new AbortController();
		// Neither answer may hold the form up, and not knowing stops nothing.
		const bounded = <T>(read: Promise<T>) =>
			Promise.race([
				read.catch(() => null),
				sleep(DESTINATION_CHECK_MS, giveUp.signal).then(
					() => null,
					() => null,
				),
			]);
		const [gas, recipientProblem] = await Promise.all([
			claimer ? bounded(gasHeldOn(to, claimer.address)) : null,
			typed && isValidAddress(typed, to) ? bounded(recipientProblemOn(to, typed)) : null,
		]);
		giveUp.abort();
		if (seq === destinationSeq && !destroyed) stores.$destination.set({ gas, recipientProblem });
	}
	for (const store of [stores.$destinationChain, stores.$destinationAccount, stores.$recipient]) {
		cleanups.push(store.listen(() => void refreshDestination()));
	}

	function warnings(): string[] {
		const to = stores.$destinationChain.get();
		const coin = gasCoin(to);
		if (!stores.$destinationAccount.get()) {
			// Sending to a typed address with no wallet for that chain connected: an exchange
			// deposit address, or a wallet on another device.
			return stores.$recipient.get()
				? [
						`USDC does not arrive on ${to.name} by itself. After the burn, it has to be claimed on ${to.name} from a wallet that holds ${coin}.`,
					]
				: [];
		}
		return stores.$destination.get().gas === 0n
			? [
					`Your ${to.name} wallet holds no ${coin}. You will need some to claim the USDC on ${to.name}.`,
				]
			: [];
	}

	let quoteSeq = 0;
	async function refreshQuote(): Promise<Quote | null> {
		const seq = ++quoteSeq;
		const from = stores.$sourceChain.get();
		const to = stores.$destinationChain.get();
		stores.$quote.set(null);
		let amount: bigint;
		try {
			amount = parseUsdc(stores.$amount.get() || '0');
		} catch {
			return null;
		}

		let quoted = false;
		let tiers: Awaited<ReturnType<typeof iris.getBurnFees>> = [];
		let fastAvailable = false;
		let fastReason: string | null = from.fastTransferAsSource
			? null
			: `${from.name} only supports standard transfers`;
		try {
			tiers = await iris.getBurnFees(from.domain, to.domain);
			quoted = true;
			const hasFastTier = tiers.some((t) => t.finalityThreshold === FINALITY_THRESHOLD.fast);
			fastAvailable = from.fastTransferAsSource && hasFastTier;
			if (from.fastTransferAsSource && !hasFastTier) {
				fastReason = 'Circle does not offer Fast Transfer on this route';
			}
		} catch (error) {
			// Circle does not quote every route (Sui today, and the sandbox for some testnets).
			// Standard transfers carry no Circle fee, so they stay available without a quote.
			if (from.fastTransferAsSource) {
				fastReason =
					error instanceof IrisError
						? 'Circle has not published Fast Transfer fees for this route yet'
						: "Couldn't fetch Circle's fee quote";
			}
		}
		if (seq !== quoteSeq) return stores.$quote.get();

		stores.$fastAvailable.set(fastAvailable);
		stores.$fastUnavailableReason.set(fastAvailable ? null : fastReason);

		const canStandard = allowedSpeeds.includes('standard');
		const speed: TransferSpeed =
			preferredSpeed === 'fast' && fastAvailable ? 'fast' : canStandard ? 'standard' : 'fast';
		if (speed === 'fast' && !fastAvailable) {
			// Host allows only fast transfers and this route cannot do them.
			stores.$quoteError.set(fastReason ?? 'Fast Transfer is not available for this route');
			return null;
		}
		stores.$quoteError.set(null);
		if (stores.$speed.get() !== speed) stores.$speed.set(speed);

		const feeBps =
			tiers.find((t) => t.finalityThreshold === FINALITY_THRESHOLD[speed])?.minimumFee ?? 0;
		const fee = feeFromBps(amount, feeBps);
		// Give fast transfers a small buffer above the quoted minimum so the attester does not
		// reject the message if the fee moves between quote and burn; maxFee must stay < amount.
		const buffered = speed === 'fast' ? fee + feeFromBps(amount, 1) : fee;
		const maxFee = amount > 0n && buffered >= amount ? amount - 1n : buffered;
		const quote: Quote = {
			from: from.key,
			to: to.key,
			speed,
			amount,
			feeBps,
			fee,
			maxFee,
			minFinalityThreshold: FINALITY_THRESHOLD[speed],
			receiveAmount: amount - fee,
			quoted,
			estimate: estimateFor(from, speed),
		};
		stores.$quote.set(quote);
		return quote;
	}

	/** The quote only counts if it was computed for exactly what the form shows now. */
	function currentQuote(): Quote | null {
		const quote = stores.$quote.get();
		if (!quote) return null;
		let amount: bigint;
		try {
			amount = parseUsdc(stores.$amount.get() || '0');
		} catch {
			return null;
		}
		if (
			quote.amount !== amount ||
			quote.from !== stores.$fromChain.get() ||
			quote.to !== stores.$toChain.get() ||
			quote.speed !== stores.$speed.get()
		) {
			return null;
		}
		return quote;
	}

	// --- Form actions ---------------------------------------------------------------------
	function setFromChain(key: ChainKey) {
		if (!routes.from.some((c) => c.key === key)) throw new Error(`"${key}" is not a valid source`);
		stores.$fromChain.set(key);
		const options = destinationsFor(routes, key);
		if (!options.some((c) => c.key === stores.$toChain.get())) {
			stores.$toChain.set(options[0]!.key);
		}
		onRouteChanged();
	}

	function setToChain(key: ChainKey) {
		const options = destinationsFor(routes, stores.$fromChain.get());
		if (!options.some((c) => c.key === key)) {
			throw new Error(`"${key}" is not a valid destination`);
		}
		stores.$toChain.set(key);
		onRouteChanged();
	}

	function setCounterpartChain(key: ChainKey) {
		if (stores.$fromChain.get() === 'sui') setToChain(key);
		else setFromChain(key);
	}

	function flipDirection() {
		if (direction !== 'both') return;
		const from = stores.$fromChain.get();
		const to = stores.$toChain.get();
		if (
			routes.from.some((c) => c.key === to) &&
			destinationsFor(routes, to).some((c) => c.key === from)
		) {
			stores.$fromChain.set(to);
			stores.$toChain.set(from);
			onRouteChanged();
		}
	}

	function onRouteChanged() {
		stores.$recipient.set('');
		stores.$balance.setKey('source', null);
		stores.$quote.set(null);
		if (needsNonSui()) void wallets().catch(() => undefined);
		void refreshBalance();
		void refreshQuote();
	}

	function setAmount(value: string) {
		stores.$amount.set(value);
		stores.$quote.set(null);
		void refreshQuote();
	}

	function setSpeed(speed: TransferSpeed) {
		if (!allowedSpeeds.includes(speed)) return;
		if (speed === 'fast' && stores.$fastAvailable.get() === false) return;
		preferredSpeed = speed;
		stores.$speed.set(speed);
		stores.$quote.set(null);
		void refreshQuote();
	}

	function setRecipient(address: string) {
		stores.$recipient.set(address.trim());
	}

	async function connect(ecosystem: 'evm' | 'solana') {
		const adapters = await wallets();
		await adapters[ecosystem].connect();
	}

	async function disconnect(ecosystem: 'evm' | 'solana') {
		const adapters = await wallets();
		await adapters[ecosystem].disconnect();
	}

	function validate(): string | null {
		const from = stores.$sourceChain.get();
		const to = stores.$destinationChain.get();
		if (dAppKit.stores.$currentNetwork.get() !== suiChain.suiNetwork) {
			return `Switch your Sui wallet to ${suiChain.suiNetwork}`;
		}
		const sourceAccount = stores.$sourceAccount.get();
		if (!sourceAccount) return `Connect your ${from.name} wallet`;
		let amount: bigint;
		try {
			amount = parseUsdc(stores.$amount.get());
		} catch {
			return 'Enter an amount';
		}
		if (amount <= 0n) return 'Enter an amount';
		const balance = stores.$balance.get().source;
		if (balance !== null && amount > balance) return 'Insufficient USDC balance';
		const recipient = stores.$recipient.get() || stores.$destinationAccount.get()?.address;
		if (!recipient) return `Connect your ${to.name} wallet or enter a recipient`;
		if (!isValidAddress(recipient, to)) return `Invalid ${to.name} address`;
		const recipientProblem = stores.$recipient.get() && stores.$destination.get().recipientProblem;
		if (recipientProblem) return recipientProblem;
		const quoteError = stores.$quoteError.get();
		if (quoteError) return quoteError;
		const quote = currentQuote();
		if (!quote) return QUOTE_PENDING;
		if (quote.maxFee >= amount) return 'Amount is too small to cover the fee';
		return null;
	}

	// --- Transfers -------------------------------------------------------------------------
	function upsert(transfer: TransferRecord) {
		const list = readStored();
		const index = list.findIndex((t) => t.id === transfer.id);
		const next =
			index === -1 ? [transfer, ...list] : list.map((t) => (t.id === transfer.id ? transfer : t));
		writeStored(next);
		emit({ type: 'transfer:updated', transfer });
	}

	async function execute(
		record: TransferRecord,
		options: { stopAfterAttestation?: boolean } = {},
	): Promise<TransferRecord> {
		const key = runKey(record.id);
		if (RUNNING.has(key)) throw new Error('Transfer is already running');
		if (runningElsewhere(record.id)) {
			throw new Error('This transfer is being handled in another tab.');
		}
		RUNNING.add(key);
		const releaseLease = takeLease(record.id);
		const controller = new AbortController();
		controllers.set(record.id, controller);
		stores.$activeTransferId.set(record.id);
		let burned = !!record.sourceTxHash;
		const stored = () => readStored().find((t) => t.id === record.id);
		try {
			const result = await runTransfer(record, {
				dAppKit,
				wallets,
				iris,
				chains,
				signal: controller.signal,
				stopAfterAttestation: options.stopAfterAttestation,
				onUpdate: (transfer) => {
					// The run works on the copy of the record it started with. Whether the user has
					// dismissed the transfer since then is not the run's to say: keep what is stored.
					const now = stored();
					upsert(now ? { ...transfer, hidden: now.hidden } : transfer);
					// The balance changed when the burn confirmed. Show that now: the form is free
					// again from this point, and the rest of the transfer can take minutes.
					if (!burned && transfer.sourceTxHash && transfer.status === 'attesting') {
						burned = true;
						void refreshBalance();
					}
				},
			});
			const latest = stored() ?? result;
			if (latest.status === 'complete') emit({ type: 'transfer:complete', transfer: latest });
			void refreshBalance();
			return latest;
		} catch (error) {
			const latest = stored() ?? record;
			emit({ type: 'transfer:failed', transfer: latest, error });
			void refreshBalance();
			throw error;
		} finally {
			controllers.delete(record.id);
			RUNNING.delete(key);
			releaseLease();
		}
	}

	async function transfer(): Promise<TransferRecord> {
		const problem = validate();
		if (problem) throw new Error(problem);
		const quote = currentQuote()!;
		const from = stores.$sourceChain.get();
		const to = stores.$destinationChain.get();
		const recipient = normalizeAddress(
			stores.$recipient.get() || stores.$destinationAccount.get()!.address,
			to,
		);
		const now = Date.now();
		const record: TransferRecord = {
			id: `${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
			network,
			from: from.key,
			to: to.key,
			amount: quote.amount.toString(),
			maxFee: quote.maxFee.toString(),
			speed: quote.speed,
			sender: stores.$sourceAccount.get()!.address,
			recipient,
			status: 'pending',
			createdAt: now,
			updatedAt: now,
		};
		upsert(record);
		return execute(record);
	}

	async function resume(id: string): Promise<TransferRecord> {
		const record = readStored().find((t) => t.id === id);
		if (!record) throw new Error(`Unknown transfer ${id}`);
		return execute({ ...record, error: undefined });
	}

	/** The user asked for this transfer by hash, so list it whichever wallet is connected. */
	function track(id: string) {
		stores.$trackedTransferIds.set(new Set([...stores.$trackedTransferIds.get(), id]));
	}

	async function importTransfer(input: { txHash: string; sourceChain?: ChainKey }) {
		// The hash, or an explorer's link to it. A chain the caller names wins over the link's.
		const pasted = parseTxReference(input.txHash, chains);
		const txHash = pasted.txHash;
		const from = resolveSourceChain(txHash, chains, input.sourceChain ?? pasted.chain);
		const existing = readStored().find((t) => t.sourceTxHash === txHash);
		if (existing) {
			track(existing.id);
			stores.$transfers.set(readStored());
			if (!RUNNING.has(runKey(existing.id)) && existing.status !== 'complete') {
				void execute({ ...existing, error: undefined }, { stopAfterAttestation: true }).catch(
					() => undefined,
				);
			}
			return existing;
		}

		let message: IrisMessage | null = null;
		try {
			message = (await iris.getMessagesByTxHash(from.domain, txHash)).messages[0] ?? null;
		} catch (error) {
			if (!(error instanceof IrisError && error.status === 404)) throw error;
		}

		let details: BurnDetails | null = message ? burnDetailsFromIris(message) : null;
		if (!details && from.ecosystem === 'evm') {
			const burn = await getEvmBurnDetails(from, txHash as `0x${string}`);
			if (burn) {
				details = {
					amount: burn.amount,
					destinationDomain: burn.destinationDomain,
					mintRecipient: hexToBytes(burn.mintRecipient),
					sender: burn.depositor,
					maxFee: burn.maxFee,
					minFinalityThreshold: burn.minFinalityThreshold,
				};
			}
		}
		if (!details) {
			throw new Error(
				message
					? 'Circle has not decoded this transfer yet; try again in a minute'
					: `No CCTP transfer found for that hash on ${from.name}`,
			);
		}

		// On Solana the mint recipient is a token account; store the wallet that owns it so a
		// later claim can (re)create the account and the UI shows a wallet address.
		let recipient: string | undefined;
		const to = chains.find((c) => c.domain === details.destinationDomain);
		if (to?.ecosystem === 'solana') {
			const owner = await getSolanaTokenAccountOwner(
				to,
				new PublicKey(details.mintRecipient),
			).catch(() => null);
			recipient = owner?.toBase58();
		}
		const burnedAt = (await lookupBurnTime(from, txHash).catch(() => null)) ?? undefined;
		const record = buildImportedRecord({
			network,
			chains,
			from,
			txHash,
			details,
			message,
			recipient,
			burnedAt,
		});
		upsert(record);
		track(record.id);
		// Nothing to drive until the user claims when the attestation is already in hand.
		if (record.status !== 'readyToMint') {
			void execute(record, { stopAfterAttestation: true }).catch(() => undefined);
		}
		return record;
	}

	/** Source-chain confirmation time of a burn, in ms; null for a transaction that failed. */
	async function lookupBurnTime(from: ChainDefinition, txHash: string): Promise<number | null> {
		switch (from.ecosystem) {
			case 'evm':
				return getEvmTransactionTime(from, txHash as `0x${string}`);
			case 'sui':
				return getSuiTransactionTime(dAppKit.getClient(from.suiNetwork), txHash);
			case 'solana':
				return getSolanaTransactionTime(from, txHash);
		}
	}

	/**
	 * Records written before `burnedAt` existed (or tracked before we looked it up) count their
	 * wait from the wrong moment. Fill it in once from the chain, in the background.
	 */
	async function backfillBurnTimes() {
		for (const record of readStored()) {
			if (!record.sourceTxHash || record.burnedAt) continue;
			const from = chains.find((c) => c.key === record.from);
			if (!from) continue;
			const burnedAt = await lookupBurnTime(from, record.sourceTxHash).catch(() => null);
			if (!burnedAt || destroyed) continue;
			const latest = readStored().find((t) => t.id === record.id);
			if (!latest || latest.burnedAt) continue;
			upsert({
				...latest,
				burnedAt,
				createdAt: Math.min(latest.createdAt, burnedAt),
				attestingSince: Math.min(latest.attestingSince ?? burnedAt, burnedAt),
			});
		}
	}

	function isRunning(id: string) {
		return RUNNING.has(runKey(id)) || runningElsewhere(id);
	}

	function setHidden(id: string, hidden: boolean) {
		const list = readStored();
		if (!list.some((t) => t.id === id)) return;
		writeStored(list.map((t) => (t.id === id ? { ...t, hidden, updatedAt: Date.now() } : t)));
		if (hidden && stores.$activeTransferId.get() === id) stores.$activeTransferId.set(null);
	}

	function dismiss(id: string) {
		setHidden(id, true);
	}

	function restore(id: string) {
		setHidden(id, false);
	}

	function remove(id: string) {
		controllers.get(id)?.abort();
		controllers.delete(id);
		writeStored(readStored().filter((t) => t.id !== id));
		if (stores.$activeTransferId.get() === id) stores.$activeTransferId.set(null);
	}

	function removeUnburned(id: string): boolean {
		const stored = readStored().find((t) => t.id === id);
		const removable =
			!!stored &&
			!stored.sourceTxHash &&
			!stored.droppedSourceTxHash &&
			!stored.attestation &&
			stored.status !== 'complete' &&
			!isRunning(id);
		if (!removable) {
			// This page's copy was out of date. Show what is true instead.
			stores.$transfers.set(readStored());
			return false;
		}
		remove(id);
		return true;
	}

	function destroy() {
		destroyed = true;
		for (const controller of controllers.values()) controller.abort();
		controllers.clear();
		for (const cleanup of cleanups.splice(0)) cleanup();
	}

	// Pick up transfers interrupted by a reload: keep polling for attestations, but stop short
	// of the mint, which needs the user's wallet (the widget shows Claim). Skip anything another
	// kit on the page, or another tab, is already driving. A tab that died without releasing its
	// claim holds it a little longer, so look again once the claims seen here have lapsed.
	let resumeTimer: ReturnType<typeof setTimeout> | undefined;
	cleanups.push(() => clearTimeout(resumeTimer));
	function resumeInterrupted() {
		let lookAgainAt = 0;
		for (const record of readStored()) {
			const interrupted =
				record.status === 'attesting' ||
				record.status === 'minting' ||
				(record.status === 'burning' && !!record.sourceTxHash) ||
				// Failed while waiting for the attestation (e.g. an old timeout or a network
				// outage): the burn was sent, so keep watching for it.
				(record.status === 'failed' && !!record.sourceTxHash && !record.attestation);
			if (!interrupted || RUNNING.has(runKey(record.id))) continue;
			const holder = leaseHolder(record.id);
			if (holder && holder.owner !== PAGE_ID) {
				lookAgainAt = Math.max(lookAgainAt, holder.until);
				continue;
			}
			void execute({ ...record, error: undefined }, { stopAfterAttestation: true }).catch(
				() => undefined,
			);
		}
		if (lookAgainAt && !destroyed) {
			resumeTimer = setTimeout(resumeInterrupted, lookAgainAt - Date.now() + 1_000);
			(resumeTimer as { unref?: () => void }).unref?.();
		}
	}
	resumeInterrupted();

	void backfillBurnTimes();
	void refreshBalance();
	void refreshQuote();
	void refreshDestination();

	return {
		config,
		network,
		chains,
		routes,
		allowedSpeeds,
		stores,
		iris,
		wallets,
		setFromChain,
		setToChain,
		setCounterpartChain,
		flipDirection,
		setAmount,
		setSpeed,
		setRecipient,
		connect,
		disconnect,
		refreshBalance,
		refreshQuote,
		validate,
		warnings,
		transfer,
		resume,
		importTransfer,
		isRunning,
		dismiss,
		restore,
		remove,
		removeUnburned,
		destroy,
	};
}

/** Attestation wait for a source chain and speed, from Circle's published finality table. */
export function estimateFor(
	chain: ChainDefinition,
	speed: TransferSpeed,
): { minSeconds: number; maxSeconds: number } {
	const range = (speed === 'fast' && chain.finality.fast) || chain.finality.standard;
	return { minSeconds: range[0], maxSeconds: range[1] };
}

function pickInitialFrom(
	routes: ResolvedRoutes,
	preferred: ChainKey | undefined,
	direction: string,
): ChainKey {
	if (preferred && routes.from.some((c) => c.key === preferred)) return preferred;
	if (direction === 'both') {
		// Default to bridging *into* Sui from Ethereum when available, since that is the common
		// onboarding path for a Sui dapp.
		const ethereum = routes.from.find((c) => c.key === 'ethereum');
		if (ethereum && destinationsFor(routes, 'ethereum').length) return 'ethereum';
	}
	return routes.from[0]!.key;
}

function pickInitialTo(
	routes: ResolvedRoutes,
	from: ChainKey,
	preferred: ChainKey | undefined,
): ChainKey {
	const options = destinationsFor(routes, from);
	if (preferred && options.some((c) => c.key === preferred)) return preferred;
	if (!options.length) throw new Error(`No destinations available from "${from}"`);
	return options[0]!.key;
}

function pickInitialSpeed(
	preferred: TransferSpeed | undefined,
	allowed: TransferSpeed[],
): TransferSpeed {
	if (preferred && allowed.includes(preferred)) return preferred;
	return allowed.includes('fast') ? 'fast' : 'standard';
}

export { findChain };
