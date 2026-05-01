import type { ClientWithCoreApi } from '@mysten/sui/client';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { Transaction } from '@mysten/sui/transactions';
import { toBase64 } from '@mysten/sui/utils';
import {
	ReadonlyWalletAccount,
	type SUI_DEVNET_CHAIN,
	SUI_LOCALNET_CHAIN,
	type SUI_MAINNET_CHAIN,
	type SUI_TESTNET_CHAIN,
	type StandardConnectFeature,
	type StandardConnectMethod,
	type StandardDisconnectFeature,
	type StandardDisconnectMethod,
	type StandardEventsFeature,
	type StandardEventsListeners,
	type StandardEventsOnMethod,
	type SuiSignAndExecuteTransactionFeature,
	type SuiSignAndExecuteTransactionMethod,
	type SuiSignPersonalMessageFeature,
	type SuiSignPersonalMessageMethod,
	type SuiSignTransactionFeature,
	type SuiSignTransactionMethod,
	type Wallet,
	getWallets,
} from '@mysten/wallet-standard';
import mitt from 'mitt';

import { DEV_WALLET_ICON } from './icon.js';

export type DevWalletChain =
	| typeof SUI_LOCALNET_CHAIN
	| typeof SUI_DEVNET_CHAIN
	| typeof SUI_TESTNET_CHAIN
	| typeof SUI_MAINNET_CHAIN;

export interface DevWalletInit {
	/** Display label shown in the connect modal (e.g. "alice"). */
	label: string;
	/** Bech32-encoded `suiprivkey1...` secret key. */
	secretKey: string;
	/** A core-API client (gRPC, GraphQL, or JSON-RPC) the wallet should sign through. */
	client: ClientWithCoreApi;
	/** Chain identifier (defaults to `sui:localnet`). */
	chain?: DevWalletChain;
}

type Events = { change: Parameters<StandardEventsListeners['change']>[0] };

/**
 * Programmatic wallet-standard wallet backed by a known Ed25519 keypair.
 * Intended for local development and end-to-end tests — never wire production
 * keys through this.
 */
export class DevWallet implements Wallet {
	readonly version = '1.0.0' as const;
	readonly id: string;
	readonly name: string;
	readonly icon = DEV_WALLET_ICON;
	readonly chains: readonly DevWalletChain[];
	readonly accounts: readonly ReadonlyWalletAccount[];

	#events = mitt<Events>();
	#keypair: Ed25519Keypair;
	#client: ClientWithCoreApi;

	constructor(init: DevWalletInit) {
		const chain = init.chain ?? SUI_LOCALNET_CHAIN;
		const keypair = Ed25519Keypair.fromSecretKey(init.secretKey);
		this.id = `dev-wallet:${init.label}`;
		this.name = `Dev: ${init.label}`;
		this.chains = [chain];
		this.#keypair = keypair;
		this.#client = init.client;
		this.accounts = [
			new ReadonlyWalletAccount({
				address: keypair.toSuiAddress(),
				publicKey: keypair.getPublicKey().toRawBytes(),
				chains: [chain],
				features: [
					'sui:signTransaction',
					'sui:signAndExecuteTransaction',
					'sui:signPersonalMessage',
				],
				label: init.label,
			}),
		];
	}

	get features(): StandardConnectFeature &
		StandardDisconnectFeature &
		StandardEventsFeature &
		SuiSignTransactionFeature &
		SuiSignAndExecuteTransactionFeature &
		SuiSignPersonalMessageFeature {
		return {
			'standard:connect': {
				version: '1.0.0',
				connect: this.#connect,
			},
			'standard:disconnect': {
				version: '1.0.0',
				disconnect: this.#disconnect,
			},
			'standard:events': {
				version: '1.0.0',
				on: this.#on,
			},
			'sui:signTransaction': {
				version: '2.0.0',
				signTransaction: this.#signTransaction,
			},
			'sui:signAndExecuteTransaction': {
				version: '2.0.0',
				signAndExecuteTransaction: this.#signAndExecuteTransaction,
			},
			'sui:signPersonalMessage': {
				version: '1.1.0',
				signPersonalMessage: this.#signPersonalMessage,
			},
		};
	}

	#connect: StandardConnectMethod = async () => ({ accounts: this.accounts });

	#disconnect: StandardDisconnectMethod = async () => {
		// stateless wallet — nothing to tear down
	};

	#on: StandardEventsOnMethod = (event, listener) => {
		this.#events.on(event, listener as never);
		return () => this.#events.off(event, listener as never);
	};

	#signTransaction: SuiSignTransactionMethod = async ({ transaction, account }) => {
		const tx = Transaction.from(await transaction.toJSON());
		tx.setSenderIfNotSet(account.address);
		const bytes = await tx.build({ client: this.#client });
		const { signature } = await this.#keypair.signTransaction(bytes);
		return { bytes: toBase64(bytes), signature };
	};

	#signAndExecuteTransaction: SuiSignAndExecuteTransactionMethod = async ({
		transaction,
		account,
	}) => {
		const tx = Transaction.from(await transaction.toJSON());
		tx.setSenderIfNotSet(account.address);
		const bytes = await tx.build({ client: this.#client });

		const result = await this.#keypair.signAndExecuteTransaction({
			transaction: tx,
			client: this.#client,
		});
		const wrapped = result.Transaction ?? result.FailedTransaction;
		if (!wrapped) throw new Error('Transaction execution returned no result');

		return {
			digest: wrapped.digest,
			bytes: toBase64(bytes),
			signature: wrapped.signatures[0] ?? '',
			effects: toBase64(wrapped.effects.bcs ?? new Uint8Array()),
		};
	};

	#signPersonalMessage: SuiSignPersonalMessageMethod = async ({ message }) => {
		const { signature } = await this.#keypair.signPersonalMessage(message);
		return { bytes: toBase64(message), signature };
	};
}

/**
 * Convenience helper — registers a fresh DevWallet with the global wallet-standard
 * registry. Returns an unregister callback.
 */
export function registerDevWallet(init: DevWalletInit): () => void {
	const wallet = new DevWallet(init);
	return getWallets().register(wallet);
}
