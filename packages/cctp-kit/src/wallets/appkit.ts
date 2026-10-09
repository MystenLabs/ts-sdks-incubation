// Copyright (c) Mysten Labs, Inc.
// SPDX-License-Identifier: Apache-2.0

import { fallback, http } from 'viem';
import type { Transport } from 'viem';
import type { Connection, Signer, Transaction as SolanaTransaction } from '@solana/web3.js';
import { getChainRegistry } from '../chains/index.js';
import type {
	ChainDefinition,
	EvmChainDefinition,
	Network,
	SolanaChainDefinition,
} from '../chains/types.js';
import { signAndSendSolanaTransaction } from './solana.js';
import type { SolanaProviderLike } from './solana.js';
import { createEvmWalletFromWagmiConfig } from './wagmi.js';
import type { SolanaWalletAdapter, WalletAccount, WalletAdapters } from './types.js';

export interface AppKitWalletOptions {
	/**
	 * Reown Cloud project id. Required for WalletConnect (mobile wallets via QR / deep link).
	 * Without it the widget still works with browser-extension wallets, but WalletConnect is
	 * disabled.
	 */
	projectId?: string;
	metadata?: { name: string; description: string; url: string; icons: string[] };
	themeMode?: 'light' | 'dark';
}

interface CreateAppKitWalletsArgs extends AppKitWalletOptions {
	network: Network;
	chains: ChainDefinition[];
}

/** Placeholder used when no project id is configured; WalletConnect is disabled in that case. */
const NO_PROJECT_ID = '00000000000000000000000000000000';

let appKitPromise: Promise<WalletAdapters> | undefined;

/**
 * Create the default wallet layer: one Reown AppKit instance that owns both the EVM (wagmi)
 * and Solana connections. AppKit is a module-level singleton, so this is memoised; the
 * first call's options win.
 */
export function createAppKitWallets(args: CreateAppKitWalletsArgs): Promise<WalletAdapters> {
	appKitPromise ??= buildAppKitWallets(args);
	return appKitPromise;
}

async function buildAppKitWallets(args: CreateAppKitWalletsArgs): Promise<WalletAdapters> {
	const [{ createAppKit }, { WagmiAdapter }, { SolanaAdapter }, networks] = await Promise.all([
		import('@reown/appkit'),
		import('@reown/appkit-adapter-wagmi'),
		import('@reown/appkit-adapter-solana'),
		import('@reown/appkit/networks'),
	]);

	// AppKit is a page-wide singleton, so it must know every chain any kit on the page may use:
	// a host can run a testnet kit and a mainnet kit over its lifetime (the example app does).
	// Chains passed by the caller win (they carry the host's RPC overrides); the rest of both
	// registries fill in the gaps.
	const byChainId = new Map<number, EvmChainDefinition>();
	const solanaByCluster = new Map<string, SolanaChainDefinition>();
	for (const chain of [
		...getChainRegistry('mainnet'),
		...getChainRegistry('testnet'),
		...args.chains,
	]) {
		if (chain.ecosystem === 'evm') byChainId.set(chain.chainId, chain);
		if (chain.ecosystem === 'solana') solanaByCluster.set(chain.cluster, chain);
	}
	const evmChains = [...byChainId.values()];
	const solanaChain = args.chains.find((c): c is SolanaChainDefinition => c.ecosystem === 'solana');
	const configuredProjectId = args.projectId?.trim() || undefined;
	const projectId = configuredProjectId ?? NO_PROJECT_ID;

	const transports: Record<number, Transport> = {};
	for (const chain of evmChains) {
		transports[chain.chainId] = fallback(
			chain.rpcUrls.map((url) => http(url, { timeout: 10_000 })),
		);
	}

	const evmNetworks = evmChains.map((c) => c.viemChain);
	const solanaNetworks = [networks.solana, networks.solanaDevnet];
	const allNetworks = [
		...evmNetworks,
		...(solanaChain || solanaByCluster.size ? solanaNetworks : []),
	] as unknown as [(typeof networks)['solana'], ...(typeof networks)['solana'][]];

	const wagmiAdapter = new WagmiAdapter({
		networks: evmNetworks as unknown as [
			(typeof networks)['mainnet'],
			...(typeof networks)['mainnet'][],
		],
		projectId,
		transports,
	});
	const solanaAdapter = new SolanaAdapter();

	const appKit = createAppKit({
		adapters: [wagmiAdapter, solanaAdapter],
		networks: allNetworks,
		projectId,
		metadata: args.metadata ?? {
			name: 'USDC Bridge',
			description: 'Bridge USDC to and from Sui with Circle CCTP',
			url: typeof window !== 'undefined' ? window.location.origin : 'https://sui.io',
			icons: [],
		},
		enableWalletConnect: configuredProjectId !== undefined,
		themeMode: args.themeMode,
		features: {
			analytics: false,
			email: false,
			socials: false,
			swaps: false,
			onramp: false,
			send: false,
			history: false,
		},
	});

	const evm = createEvmWalletFromWagmiConfig(wagmiAdapter.wagmiConfig, {
		openConnect: async () => {
			await appKit.open({ view: 'Connect', namespace: 'eip155' });
		},
	});
	// AppKit owns disconnects for the shared session.
	evm.disconnect = () => appKit.disconnect('eip155');

	const solanaAccount = (): WalletAccount | null => {
		try {
			const account = appKit.getAccount('solana');
			return account?.address ? { address: account.address } : null;
		} catch {
			return null;
		}
	};

	const solana: SolanaWalletAdapter = {
		ecosystem: 'solana',
		getAccount: solanaAccount,
		subscribe(listener) {
			return appKit.subscribeAccount(() => listener(solanaAccount()), 'solana');
		},
		async connect() {
			await appKit.open({ view: 'Connect', namespace: 'solana' });
		},
		async disconnect() {
			await appKit.disconnect('solana');
		},
		async signAndSendTransaction(
			transaction: SolanaTransaction,
			connection: Connection,
			signers?: Signer[],
		) {
			const provider = appKit.getProvider<SolanaProviderLike>('solana');
			if (!provider) throw new Error('No Solana wallet is connected');
			return signAndSendSolanaTransaction(provider, transaction, connection, signers);
		},
	};

	return { evm, solana };
}
