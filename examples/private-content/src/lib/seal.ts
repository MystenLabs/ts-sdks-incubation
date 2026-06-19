import {
	EncryptedObject,
	SealClient,
	type KeyServerConfig,
	type SealCompatibleClient,
	SessionKey,
} from '@mysten/seal';
import { Transaction } from '@mysten/sui/transactions';

import { dAppKit, vaultPackageIdFor } from '../dapp-kit.js';
import { deploymentForNetwork } from './deployment.js';
import { bytesToHex, hexToBytes } from './format.js';
import * as vault from '@generated/bindings/vault/vault.js';

const SEAL_THRESHOLD = 1; // Open mode, single key server.

let cachedClient: SealClient | null = null;
let cachedClientKey = '';

/**
 * Returns a singleton SealClient pinned to our local key server. Recreated
 * if the deployment changes (e.g., a fresh `pnpm dev` registers a new
 * KeyServer object id).
 */
const serverConfigsCacheKey = (configs: ReadonlyArray<KeyServerConfig>) =>
	configs
		.map(
			(config) =>
				`${config.objectId}:${config.weight}:${config.aggregatorUrl ?? ''}:${config.apiKeyName ?? ''}`,
		)
		.join('|');

export function getSealClient(
	suiClient: SealCompatibleClient,
	network: string,
	serverConfigs?: ReadonlyArray<KeyServerConfig>,
): SealClient {
	const dep = deploymentForNetwork(network);
	if (!dep.seal) {
		throw new Error(
			'getSealClient: seal bindings are missing. Did `devstack apply` complete the seal bootstrap step?',
		);
	}
	const configs = serverConfigs ?? dep.seal.serverConfigs ?? [];
	const key = `${network}|${serverConfigsCacheKey(configs)}`;
	if (cachedClient && cachedClientKey === key) return cachedClient;
	cachedClient = new SealClient({
		suiClient,
		serverConfigs: [...configs],
		// Self-signed key server in Open mode — the SDK can't verify it
		// against the on-chain registration without the public key
		// matching what we generated locally; skipping verification is
		// fine for a single-server localnet.
		verifyKeyServers: false,
	});
	cachedClientKey = key;
	return cachedClient;
}

export function serverConfigsForEncryptedObject(encrypted: Uint8Array): KeyServerConfig[] {
	const parsed = EncryptedObject.parse(encrypted);
	const weights = new Map<string, number>();
	for (const [objectId] of parsed.services) {
		weights.set(objectId, (weights.get(objectId) ?? 0) + 1);
	}
	return Array.from(weights.entries()).map(([objectId, weight]) => ({ objectId, weight }));
}

/**
 * Generate a fresh 32-byte IBE identity for a new file. The identity is
 * stored on-chain in `File.seal_id` and bound to the file by the policy
 * contract; the same identity is sent to the key server at decrypt time.
 * Crypto value comes from cap ownership, not from this id staying secret.
 */
export function freshSealId(): { hex: string; bytes: Uint8Array } {
	const bytes = new Uint8Array(32);
	crypto.getRandomValues(bytes);
	return { hex: bytesToHex(bytes), bytes };
}

/**
 * Encrypt `data` for an IBE identity that the uploader will commit to
 * `File.seal_id` in the same upload tx. Returns the ciphertext bytes
 * ready to ship as a `vector<u8>` Move arg.
 */
export async function encryptForSealId(opts: {
	suiClient: SealCompatibleClient;
	network: string;
	sealIdHex: string;
	data: Uint8Array;
}): Promise<Uint8Array> {
	const seal = getSealClient(opts.suiClient, opts.network);
	const vaultPackageId = vaultPackageIdFor(opts.network);
	if (!vaultPackageId) throw new Error('encryptForSealId: vault package not deployed');
	const { encryptedObject } = await seal.encrypt({
		threshold: SEAL_THRESHOLD,
		packageId: vaultPackageId,
		id: opts.sealIdHex,
		data: opts.data,
	});
	return encryptedObject;
}

/**
 * Decrypt the given encrypted bytes assuming the connected wallet is in
 * `File.authorized`. Builds the seal_approve dry-run tx (pure + shared
 * object refs only — owned objects break onlyTransactionKind builds),
 * fetches a key share, runs AES-GCM decrypt.
 */
export async function decryptForFile(opts: {
	suiClient: SealCompatibleClient;
	network: string;
	address: string;
	fileId: string;
	sealIdHex: string;
	encrypted: Uint8Array;
}): Promise<Uint8Array> {
	const seal = getSealClient(
		opts.suiClient,
		opts.network,
		serverConfigsForEncryptedObject(opts.encrypted),
	);
	const vaultPackageId = vaultPackageIdFor(opts.network);
	if (!vaultPackageId) throw new Error('decryptForFile: vault package not deployed');

	const sessionKey = await SessionKey.create({
		address: opts.address,
		packageId: vaultPackageId,
		ttlMin: 10,
		suiClient: opts.suiClient,
	});
	const message = sessionKey.getPersonalMessage();
	const signResult = await dAppKit.signPersonalMessage({ message });
	await sessionKey.setPersonalMessageSignature(signResult.signature);

	const tx = new Transaction();
	// Binding default (`options.package ?? 'vault'`); the grpc client's MVR
	// overrides resolve `'vault'` to the deployed package id when the
	// onlyTransactionKind tx is built below.
	tx.add(
		vault.sealApprove({
			arguments: [Array.from(hexToBytes(opts.sealIdHex)), tx.object(opts.fileId)],
		}),
	);
	const txBytes = await tx.build({ client: opts.suiClient, onlyTransactionKind: true });

	return seal.decrypt({ data: opts.encrypted, sessionKey, txBytes });
}
