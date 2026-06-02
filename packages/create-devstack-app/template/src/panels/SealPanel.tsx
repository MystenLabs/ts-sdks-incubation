import { useCurrentAccount, useCurrentClient, useDAppKit } from '@mysten/dapp-kit-react';
import { useState } from 'react';

import { buildUploadTx, decryptForFile, encryptForSealId, freshSealId } from '../lib/seal.js';
import { useSignAndExecute, waitForCreatedObjectId } from '../lib/sign.js';
import { Panel, PanelButton } from '../ui/Panel.js';

const enc = new TextEncoder();
const dec = new TextDecoder();

/**
 * Standalone Seal panel (no Walrus): encrypt a secret for a fresh IBE
 * identity, record a shared `File` on chain bound to that identity (the
 * policy object `seal_approve` gates on), hold the ciphertext in React
 * state, then decrypt it back through the connected wallet's session key.
 */
export function SealPanel({ connected }: { connected: boolean }) {
	const account = useCurrentAccount();
	const client = useCurrentClient();
	const dAppKit = useDAppKit();
	const { mutateAsync, isPending } = useSignAndExecute();

	const [secret, setSecret] = useState('seal me · localnet only');
	const [ciphertext, setCiphertext] = useState<Uint8Array | null>(null);
	const [sealIdHex, setSealIdHex] = useState<string | null>(null);
	const [fileId, setFileId] = useState<string | null>(null);
	const [decrypted, setDecrypted] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);

	async function onEncrypt() {
		if (account === null) return;
		setError(null);
		setDecrypted(null);
		setBusy(true);
		try {
			const { hex, bytes } = freshSealId();
			const encrypted = await encryptForSealId({
				suiClient: client,
				sealIdHex: hex,
				data: enc.encode(secret),
			});
			// Record the policy File so `seal_approve` has something to gate
			// on. No Walrus here — an empty blob id is fine; only `seal_id`
			// and the `authorized` set matter for decrypt.
			const { digest } = await mutateAsync(
				buildUploadTx({ name: 'secret', blobId: new Uint8Array(), sealIdBytes: bytes }),
			);
			const createdFileId = await waitForCreatedObjectId(client, digest);
			if (createdFileId === null) {
				throw new Error('upload_entry did not create a File object');
			}
			setSealIdHex(hex);
			setCiphertext(encrypted);
			setFileId(createdFileId);
		} catch (e) {
			setError((e as Error).message);
		} finally {
			setBusy(false);
		}
	}

	async function onDecrypt() {
		if (account === null || ciphertext === null || sealIdHex === null || fileId === null) return;
		setError(null);
		setBusy(true);
		try {
			const plaintext = await decryptForFile({
				suiClient: client,
				address: account.address,
				fileId,
				sealIdHex,
				encrypted: ciphertext,
				signPersonalMessage: (message) => dAppKit.signPersonalMessage({ message }),
			});
			setDecrypted(dec.decode(plaintext));
		} catch (e) {
			setError((e as Error).message);
		} finally {
			setBusy(false);
		}
	}

	const disabled = !connected || isPending || busy;

	return (
		<Panel
			title="Seal"
			subtitle="Encrypt a secret, register its policy on chain, then decrypt it back"
			connected={connected}
			error={error}
		>
			<div className="space-y-3">
				<label className="block text-xs text-neutral-500">
					Secret
					<input
						type="text"
						value={secret}
						onChange={(e) => setSecret(e.target.value)}
						className="mt-1 w-full rounded-md border border-neutral-300 dark:border-neutral-700 bg-transparent px-2 py-1 text-sm"
					/>
				</label>

				<PanelButton testid="seal-encrypt" disabled={disabled} onClick={onEncrypt}>
					{busy && ciphertext === null ? 'Encrypting…' : 'Encrypt'}
				</PanelButton>

				{ciphertext !== null && (
					<>
						<p className="text-xs text-neutral-500 break-all">
							Ciphertext ({ciphertext.length} bytes):{' '}
							<span className="font-mono" data-testid="seal-encrypted">
								{Array.from(ciphertext.slice(0, 8))
									.map((b) => b.toString(16).padStart(2, '0'))
									.join('')}
								…
							</span>
						</p>
						<PanelButton testid="seal-decrypt" disabled={disabled} onClick={onDecrypt}>
							{busy && ciphertext !== null ? 'Decrypting…' : 'Decrypt'}
						</PanelButton>
					</>
				)}

				{decrypted !== null && (
					<p className="text-sm">
						Decrypted:{' '}
						<span className="font-mono" data-testid="seal-decrypted">
							{decrypted}
						</span>
					</p>
				)}
			</div>
		</Panel>
	);
}
