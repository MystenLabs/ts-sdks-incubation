// Seal + vault private-content probe — the full encrypt → store → decrypt
// flow, headless, as the snapshot/restore survival unit for Seal.
//
// State = an encrypted file: ciphertext (Seal IBE) stored on Walrus, with a
// shared `vault::File` registered on-chain binding the blob id + the IBE
// identity + the actor's decrypt access. `exists` re-reads the File from the
// fullnode, pulls the ciphertext back off Walrus, rebuilds a SessionKey + the
// `seal_approve` dry-run tx, decrypts, and asserts the plaintext round-trips —
// so a true result means the on-chain File, the Walrus blob, AND the Seal key
// material all survived together (any churn in the vault packageId / seal
// key-server object / walrus deploy ids breaks decryption).
//
// Headless deltas vs. a browser wallet flow:
//   - SessionKey is signed by passing the real Ed25519 Signer to
//     SessionKey.create; the SDK auto-signs the personal message inside
//     getCertificate(), so there's no wallet signPersonalMessage round-trip.
//   - verifyKeyServers:false — the localnet keygen server is self-signed, so
//     the default GET /v1/service proof-of-possession check would reject it.
//
// Requires the REAL router (useRealRouter): Seal's POST /v1/fetch_key targets
// the key server's ON-CHAIN-registered URL — the Traefik vhost
// `key-server.<stack>.<app>.localhost` — which only the real router resolves
// (the same constraint the walrus probe documents for its sliver writes).

import { SealClient, SessionKey } from '@mysten/seal';
import { Transaction } from '@mysten/sui/transactions';

import {
	createdObjectOfType,
	makeWalrusClient,
	signAndExecuteAs,
	writeBlobWithRetry,
	type ProbeEnv,
} from '../clients.ts';
import type { Probe } from '../probe.ts';

const SEAL_THRESHOLD = 1; // Open mode, single local key server.

interface VaultSealHandle {
	readonly blobId: string; // walrus read id (URL-safe base64)
	readonly fileObjectId: string | undefined; // shared vault::File id
	readonly sealIdHex: string; // 32-byte IBE identity, hex (no 0x)
	readonly plaintextHex: string; // expected plaintext, hex
}

const bytesToHex = (b: Uint8Array): string => {
	let s = '';
	for (const x of b) s += x.toString(16).padStart(2, '0');
	return s;
};
const hexToBytes = (hex: string): Uint8Array => {
	const out = new Uint8Array(hex.length / 2);
	for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
	return out;
};
// walrus blob id (URL-safe base64) -> the raw 32 bytes the Move field stores.
const blobIdToBytes = (blobId: string): Uint8Array => {
	const b64 = blobId.replace(/-/g, '+').replace(/_/g, '/');
	const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
	const bin = atob(padded);
	const out = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
	return out;
};
const arraysEqual = (a: Uint8Array, b: Uint8Array): boolean =>
	a.length === b.length && a.every((x, i) => x === b[i]);

// ClientWithCoreApi structurally satisfies Seal's `SealCompatibleClient`
// (ClientWithExtensions<{ core }>) and SessionKey's suiClient param, but the
// nominal generics differ — cast at the boundary (the browser example casts
// the same way for its dApp-kit client).
const sealSuiClient = (env: ProbeEnv): never => env.suiClient as never;

const makeSealClient = (env: ProbeEnv): SealClient =>
	new SealClient({
		suiClient: sealSuiClient(env),
		serverConfigs: env.seal.serverConfigs.map((c) => ({ objectId: c.objectId, weight: c.weight })),
		verifyKeyServers: false, // self-signed local keygen server
	});

export const vaultSealProbe: Probe<VaultSealHandle> = {
	name: 'vault-seal',

	async createState(env: ProbeEnv, label: string): Promise<VaultSealHandle> {
		// Fresh IBE identity + a label-unique plaintext so S1/S2/S3 differ.
		const sealIdBytes = crypto.getRandomValues(new Uint8Array(32));
		const sealIdHex = bytesToHex(sealIdBytes);
		const plaintext = new TextEncoder().encode(
			`snapshot-matrix vault-seal ${label} ${env.address} ${sealIdHex}`,
		);

		// 1) encrypt under the vault package + this IBE identity.
		const seal = makeSealClient(env);
		const { encryptedObject } = await seal.encrypt({
			threshold: SEAL_THRESHOLD,
			packageId: env.vaultPackageId,
			id: sealIdHex,
			data: plaintext,
		});

		// 2) store the ciphertext on walrus.
		const walrus = makeWalrusClient(env.suiClient, env.walrus);
		const written = await writeBlobWithRetry(walrus, {
			blob: encryptedObject,
			signer: env.keypair,
			epochs: 5,
			deletable: true,
		});
		const blobIdBytes = blobIdToBytes(written.blobId);

		// 3) register the File on-chain (shares the File, mints a Cap to the
		//    actor + adds the actor to File.authorized). Resolve the SHARED
		//    File id from the creating tx's effects (listOwnedObjects can't see
		//    a shared object).
		const { changes } = await signAndExecuteAs(env.suiClient, env.keypair, (tx) => {
			tx.moveCall({
				target: `${env.vaultPackageId}::vault::upload_entry`,
				arguments: [
					tx.pure.string(`${label}.bin`),
					tx.pure.vector('u8', Array.from(blobIdBytes)),
					tx.pure.vector('u8', Array.from(sealIdBytes)),
				],
			});
		});
		const fileObjectId = createdObjectOfType(changes, `${env.vaultPackageId}::vault::File`);

		return { blobId: written.blobId, fileObjectId, sealIdHex, plaintextHex: bytesToHex(plaintext) };
	},

	async exists(env: ProbeEnv, handle: VaultSealHandle): Promise<boolean> {
		if (handle.fileObjectId === undefined) return false;
		const fileObjectId = handle.fileObjectId;
		const expected = hexToBytes(handle.plaintextHex);
		const sealIdBytes = hexToBytes(handle.sealIdHex);

		// readBlob / decrypt can briefly race a just-certified write or a
		// freshly-restored validator, so retry like the walrus probe does.
		for (let attempt = 0; attempt < 4; attempt++) {
			try {
				// (a) the shared File must still exist on the FULLNODE (not the
				//     indexer — it lags post-restore).
				const obj = (await env.suiClient.core.getObject({ objectId: fileObjectId })) as {
					object?: unknown;
				};
				if (obj.object != null) {
					// (b) the ciphertext must still be readable off walrus.
					const walrus = makeWalrusClient(env.suiClient, env.walrus);
					const ciphertext = await walrus.readBlob({ blobId: handle.blobId });
					if (ciphertext.length > 0) {
						// (c) SessionKey signed headlessly by the real Signer.
						const sessionKey = await SessionKey.create({
							address: env.address,
							packageId: env.vaultPackageId,
							ttlMin: 10,
							suiClient: sealSuiClient(env),
							signer: env.keypair,
						});
						// (d) seal_approve dry-run tx: (id, file), tx-kind only
						//     (the File is shared, so onlyTransactionKind builds).
						const tx = new Transaction();
						tx.moveCall({
							target: `${env.vaultPackageId}::vault::seal_approve`,
							arguments: [tx.pure.vector('u8', Array.from(sealIdBytes)), tx.object(fileObjectId)],
						});
						const txBytes = await tx.build({ client: env.suiClient, onlyTransactionKind: true });
						// (e) decrypt + compare.
						const seal = makeSealClient(env);
						const plaintext = await seal.decrypt({ data: ciphertext, sessionKey, txBytes });
						if (arraysEqual(plaintext, expected)) return true;
					}
				}
			} catch {
				// not-found / decrypt failure / transient — fall through + retry.
			}
			if (attempt < 3) await new Promise((r) => setTimeout(r, 2_000));
		}
		return false;
	},
};
