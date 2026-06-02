import { CurrentAccountSigner } from '@mysten/dapp-kit-core';
import { useCurrentClient } from '@mysten/dapp-kit-react';
import { Card } from '../ui/Card.js';
import { Field } from '../ui/Field.js';
import { useMemo, useState } from 'react';

import { dAppKit, vaultPackageId } from '../dapp-kit.js';
import { stringToBytes } from '../lib/format.js';
import { useSignAndExecute } from '../lib/queries.js';
import { encryptForSealId, freshSealId } from '../lib/seal.js';
import { buildVaultUploadTransaction } from '../lib/vault-transactions.js';
import { blobIdToBytes, storeBlob } from '../lib/walrus.js';

export function UploadForm() {
	const client = useCurrentClient();
	const { mutateAsync, isPending } = useSignAndExecute({
		invalidateKeys: [['vault']],
	});
	// One signer per app session — wraps the currently-connected dapp-kit
	// account so the walrus SDK can register + certify blobs on chain
	// using the user's wallet, the same way it would on testnet/mainnet.
	// CurrentAccountSigner is not generic over the app's literal network
	// tuple, so TS needs a boundary cast even though the runtime shape is
	// the same dapp-kit object.
	const walrusSigner = useMemo(
		() =>
			new CurrentAccountSigner(
				dAppKit as unknown as ConstructorParameters<typeof CurrentAccountSigner>[0],
			),
		[],
	);

	const [name, setName] = useState('hello.txt');
	const [content, setContent] = useState('Encrypted with Seal · stored on Sui');
	const [error, setError] = useState<string | null>(null);
	const [lastDigest, setLastDigest] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);

	async function onSubmit(e: React.FormEvent) {
		e.preventDefault();
		setError(null);
		setBusy(true);
		try {
			if (!name.trim()) throw new Error('Name is required');
			if (!content) throw new Error('Content is required');
			if (!vaultPackageId) {
				throw new Error('Vault package is not deployed. Did `devstack apply` complete?');
			}

			const { hex: sealIdHex, bytes: sealIdBytes } = freshSealId();
			const data = stringToBytes(content);
			const encrypted = await encryptForSealId({ suiClient: client, sealIdHex, data });

			// Push the ciphertext to walrus first; the on-chain tx only carries
			// the resulting 32-byte blob id (plus seal_id + name + access list).
			const { blobId } = await storeBlob({
				suiClient: client,
				signer: walrusSigner,
				data: encrypted,
			});
			const blobIdBytes = blobIdToBytes(blobId);

			const tx = buildVaultUploadTransaction({
				name,
				blobId: blobIdBytes,
				sealId: sealIdBytes,
			});
			const result = await mutateAsync(tx);
			setLastDigest(result.digest);
		} catch (e) {
			console.error('[private-content upload]', e);
			setError((e as Error).message);
		} finally {
			setBusy(false);
		}
	}

	return (
		<Card title="Upload" subtitle="Encrypt with Seal, store ciphertext on-chain, mint admin Cap">
			<form className="space-y-3" onSubmit={onSubmit}>
				<Field
					label="File name"
					render={(id) => (
						<input
							id={id}
							type="text"
							data-testid="upload-name"
							className="w-full rounded-md border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-900 px-2.5 py-1.5 text-sm"
							value={name}
							onChange={(e) => setName(e.target.value)}
						/>
					)}
				/>
				<Field
					label="Content"
					render={(id) => (
						<textarea
							id={id}
							rows={4}
							data-testid="upload-content"
							className="w-full rounded-md border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-900 px-2.5 py-1.5 text-sm font-mono"
							value={content}
							onChange={(e) => setContent(e.target.value)}
						/>
					)}
				/>
				<button
					type="submit"
					data-testid="upload-submit"
					disabled={busy || isPending}
					className="w-full rounded-md bg-violet-600 hover:bg-violet-700 disabled:bg-neutral-400 text-white text-sm font-medium py-2"
				>
					{busy ? 'Encrypting…' : isPending ? 'Submitting…' : 'Upload'}
				</button>
				{error && (
					<p className="text-sm text-red-600 dark:text-red-400" data-testid="upload-error">
						{error}
					</p>
				)}
				{lastDigest && (
					<p className="text-xs text-neutral-500 break-all" data-testid="upload-tx">
						Last tx: <span className="font-mono">{lastDigest}</span>
					</p>
				)}
			</form>
		</Card>
	);
}
