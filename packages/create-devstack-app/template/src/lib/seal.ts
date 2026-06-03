// Browser-side Seal integration over the generated `seal` binding.
//
// Retargeted from examples/private-content: reads the local key server
// config straight from `@generated/seal.js` (`seal.seal.serverConfigs` /
// `objectId`). The on-chain `vault` package is referenced by NAME
// (`@local/vault`): tx move-calls go through the generated bindings (whose
// `package` default dapp-kit's MVR override map resolves), and the Seal
// SDK's IBE `packageId` namespace is resolved from that same name via the
// connected client's MVR resolver — so this lib never touches
// `config.packages.*.packageId`. The panel holds the ciphertext in React
// state (no Walrus dependency), so this lib only needs encrypt + decrypt
// against the vault::seal_approve policy gate.

import {
	EncryptedObject,
	SealClient,
	type KeyServerConfig,
	type SealCompatibleClient,
	SessionKey,
} from '@mysten/seal';
import { Transaction } from '@mysten/sui/transactions';

import {
	uploadEntry as buildUploadEntry,
	sealApprove as buildSealApprove,
} from '@generated/bindings/vault/vault.js';
import { seal } from '@generated/seal.js';
import { bytesToHex, hexToBytes } from './format.js';

const SEAL_THRESHOLD = 1; // Open mode, single local key server.

/** Named MVR form of the vault package — matches the generated binding's
 *  `package` default and `config.packages.vault.mvr`. */
const VAULT_PACKAGE = '@local/vault';

/**
 * Resolve the vault package's on-chain id from its MVR name. Seal's IBE
 * `packageId` namespace (and `SessionKey`) need a concrete id, not the
 * `@local/vault` placeholder; the connected client carries dapp-kit's MVR
 * override map, so this resolves locally with no real registry.
 */
async function resolveVaultPackageId(suiClient: SealCompatibleClient): Promise<string> {
	const { package: id } = await (
		suiClient as unknown as {
			mvr: { resolvePackage: (o: { package: string }) => Promise<{ package: string }> };
		}
	).mvr.resolvePackage({ package: VAULT_PACKAGE });
	if (id === undefined || id.length === 0) {
		throw new Error('vault package is not deployed. Did `devstack apply` complete the seal step?');
	}
	return id;
}

let cachedClient: SealClient | null = null;
let cachedClientKey = '';

const serverConfigsCacheKey = (configs: ReadonlyArray<KeyServerConfig>) =>
	configs
		.map(
			(config) =>
				`${config.objectId}:${config.weight}:${config.aggregatorUrl ?? ''}:${config.apiKeyName ?? ''}`,
		)
		.join('|');

function getSealClient(
	suiClient: SealCompatibleClient,
	serverConfigs: ReadonlyArray<KeyServerConfig> = seal.seal.serverConfigs,
): SealClient {
	const key = serverConfigsCacheKey(serverConfigs);
	if (cachedClient && cachedClientKey === key) return cachedClient;
	cachedClient = new SealClient({
		suiClient,
		serverConfigs: [...serverConfigs],
		// Self-signed key server in Open mode — skip verification for a
		// single-server localnet (the SDK can't verify it against the
		// on-chain registration without the locally-generated public key).
		verifyKeyServers: false,
	});
	cachedClientKey = key;
	return cachedClient;
}

function serverConfigsForEncryptedObject(encrypted: Uint8Array): KeyServerConfig[] {
	const parsed = EncryptedObject.parse(encrypted);
	const weights = new Map<string, number>();
	for (const [objectId] of parsed.services) {
		weights.set(objectId, (weights.get(objectId) ?? 0) + 1);
	}
	return Array.from(weights.entries()).map(([objectId, weight]) => ({ objectId, weight }));
}

/**
 * Build a `vault::upload_entry` tx that records a shared `File` bound to
 * `sealIdBytes` with the caller in its `authorized` set — the on-chain
 * policy object `seal_approve` checks at decrypt time. The standalone
 * seal panel passes an empty `blob_id` (no Walrus); the walrus panel is
 * the surface that actually stores bytes.
 */
export function buildUploadTx(opts: {
	name: string;
	blobId: Uint8Array;
	sealIdBytes: Uint8Array;
}): Transaction {
	const tx = new Transaction();
	// `package` defaults to `@local/vault` (resolved by dapp-kit's MVR map).
	buildUploadEntry({
		arguments: {
			name: opts.name,
			blobId: Array.from(opts.blobId),
			sealId: Array.from(opts.sealIdBytes),
		},
	})(tx);
	return tx;
}

/** Generate a fresh 32-byte IBE identity for a secret. */
export function freshSealId(): { hex: string; bytes: Uint8Array } {
	const bytes = new Uint8Array(32);
	crypto.getRandomValues(bytes);
	return { hex: bytesToHex(bytes), bytes };
}

/** Encrypt `data` for the IBE identity `sealIdHex`. Returns ciphertext
 *  bytes ready to hold in React state (or ship as a `vector<u8>`). */
export async function encryptForSealId(opts: {
	suiClient: SealCompatibleClient;
	sealIdHex: string;
	data: Uint8Array;
}): Promise<Uint8Array> {
	const client = getSealClient(opts.suiClient);
	const { encryptedObject } = await client.encrypt({
		threshold: SEAL_THRESHOLD,
		packageId: await resolveVaultPackageId(opts.suiClient),
		id: opts.sealIdHex,
		data: opts.data,
	});
	return encryptedObject;
}

/**
 * Decrypt `encrypted` for `fileId`, assuming the connected wallet is in
 * `File.authorized`. Builds the `seal_approve` dry-run tx, fetches a key
 * share, runs AES-GCM decrypt. `signPersonalMessage` signs the session
 * key's personal message (the panel threads dapp-kit's signer here).
 */
export async function decryptForFile(opts: {
	suiClient: SealCompatibleClient;
	address: string;
	fileId: string;
	sealIdHex: string;
	encrypted: Uint8Array;
	signPersonalMessage: (message: Uint8Array) => Promise<{ signature: string }>;
}): Promise<Uint8Array> {
	const client = getSealClient(opts.suiClient, serverConfigsForEncryptedObject(opts.encrypted));
	const packageId = await resolveVaultPackageId(opts.suiClient);

	const sessionKey = await SessionKey.create({
		address: opts.address,
		packageId,
		ttlMin: 10,
		suiClient: opts.suiClient,
	});
	const message = sessionKey.getPersonalMessage();
	const signResult = await opts.signPersonalMessage(message);
	await sessionKey.setPersonalMessageSignature(signResult.signature);

	const tx = new Transaction();
	// `package` defaults to `@local/vault` (resolved by dapp-kit's MVR map).
	buildSealApprove({
		arguments: {
			id: Array.from(hexToBytes(opts.sealIdHex)),
			file: tx.object(opts.fileId),
		},
	})(tx);
	const txBytes = await tx.build({ client: opts.suiClient, onlyTransactionKind: true });

	return client.decrypt({ data: opts.encrypted, sessionKey, txBytes });
}
