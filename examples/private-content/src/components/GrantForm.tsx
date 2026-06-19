import { useCurrentNetwork } from '@mysten/dapp-kit-react';
import { Card } from '../ui/Card.js';
import { Field } from '../ui/Field.js';
import { useMemo, useState } from 'react';

import { vaultPackageIdFor } from '../dapp-kit.js';
import { shortAddress } from '../lib/format.js';
import { useFile, useOwnedCaps, useSignAndExecute } from '../lib/queries.js';
import { buildVaultGrantTransaction } from '../lib/vault-transactions.js';

export function GrantForm({ self }: { self: string }) {
	const network = useCurrentNetwork();
	const caps = useOwnedCaps(self);
	const ownedFiles = useMemo(() => caps.data ?? [], [caps.data]);
	const [fileId, setFileId] = useState('');
	const [recipient, setRecipient] = useState('');
	const { mutateAsync, isPending } = useSignAndExecute({
		invalidateKeys: [['vault']],
	});
	const [error, setError] = useState<string | null>(null);
	const [lastDigest, setLastDigest] = useState<string | null>(null);

	const selectedFileId = fileId || ownedFiles[0]?.fileId || '';
	const selectedFile = useFile(selectedFileId || undefined);

	async function onSubmit(e: React.FormEvent) {
		e.preventDefault();
		setError(null);
		try {
			if (!selectedFileId) throw new Error('Pick a file you uploaded');
			const recipientAddress = recipient.trim();
			if (!recipientAddress) throw new Error('Enter a recipient address');
			if (!/^0x[0-9a-fA-F]+$/.test(recipientAddress)) {
				throw new Error('Recipient must be a 0x-prefixed Sui address');
			}
			if (recipientAddress === self) {
				throw new Error('Recipient must differ from the connected account');
			}
			if (selectedFile.data && selectedFile.data.owner !== self) {
				throw new Error('Only the file owner can grant new caps');
			}
			if (!vaultPackageIdFor(network)) {
				throw new Error('Vault package is not deployed. Did `devstack apply` complete?');
			}
			const tx = buildVaultGrantTransaction({
				fileId: selectedFileId,
				recipient: recipientAddress,
			});
			const result = await mutateAsync(tx);
			setLastDigest(result.digest);
		} catch (e) {
			setError((e as Error).message);
		}
	}

	const onlyOwn = ownedFiles.filter(
		(c) => selectedFile.data == null || c.fileId === selectedFile.data.id,
	);

	return (
		<Card title="Grant access" subtitle="Mint and transfer a Cap so another account can decrypt">
			<form className="space-y-3" onSubmit={onSubmit}>
				<Field
					label="File"
					render={(id) => (
						<select
							id={id}
							className="w-full rounded-md border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-900 px-2.5 py-1.5 text-sm font-mono"
							value={selectedFileId}
							onChange={(e) => setFileId(e.target.value)}
						>
							<option value="">— pick a file —</option>
							{ownedFiles.map((cap) => (
								<option key={cap.id} value={cap.fileId}>
									{shortAddress(cap.fileId)}
								</option>
							))}
						</select>
					)}
				/>
				<Field
					label="Recipient"
					render={(id) => (
						<input
							id={id}
							type="text"
							inputMode="text"
							spellCheck={false}
							placeholder="0x… recipient address"
							data-testid="grant-recipient"
							className="w-full rounded-md border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-900 px-2.5 py-1.5 text-sm font-mono"
							value={recipient}
							onChange={(e) => setRecipient(e.target.value)}
						/>
					)}
				/>
				<button
					type="submit"
					disabled={isPending || onlyOwn.length === 0}
					data-testid="grant-submit"
					className="w-full rounded-md bg-emerald-600 hover:bg-emerald-700 disabled:bg-neutral-400 text-white text-sm font-medium py-2"
				>
					{isPending ? 'Submitting…' : 'Grant cap'}
				</button>
				{error && (
					<p className="text-sm text-red-600 dark:text-red-400" data-testid="grant-error">
						{error}
					</p>
				)}
				{lastDigest && (
					<p className="text-xs text-neutral-500 break-all" data-testid="grant-tx">
						Last tx: <span className="font-mono">{lastDigest}</span>
					</p>
				)}
			</form>
		</Card>
	);
}
