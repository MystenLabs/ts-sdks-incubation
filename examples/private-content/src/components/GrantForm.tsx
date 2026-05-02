import { Transaction } from '@mysten/sui/transactions';
import { useId, useMemo, useState } from 'react';

import { deployment } from '../generated/deployment.js';
import * as vaultModule from '../generated/sui/vault/vault.js';
import { shortAddress } from '../lib/format.js';
import { useFile, useOwnedCaps, usePackage, useSignAndExecute } from '../lib/queries.js';
import { Card } from './Card.js';

export function GrantForm({ self }: { self: string }) {
	const vault = usePackage(vaultModule, 'vault');
	const caps = useOwnedCaps(self);
	const others = useMemo(
		() => Object.entries(deployment.accounts).filter(([, addr]) => addr !== self),
		[self],
	);
	const ownedFiles = useMemo(() => caps.data ?? [], [caps.data]);
	const [fileId, setFileId] = useState('');
	const [recipient, setRecipient] = useState(others[0]?.[1] ?? '');
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
			if (!recipient) throw new Error('Pick a recipient');
			if (selectedFile.data && selectedFile.data.owner !== self) {
				throw new Error('Only the file owner can grant new caps');
			}
			const tx = new Transaction();
			vault.grantEntry({ arguments: [selectedFileId, recipient] })(tx);
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
						<select
							id={id}
							className="w-full rounded-md border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-900 px-2.5 py-1.5 text-sm"
							value={recipient}
							onChange={(e) => setRecipient(e.target.value)}
						>
							{others.map(([name, addr]) => (
								<option key={name} value={addr}>
									{name} ({shortAddress(addr)})
								</option>
							))}
						</select>
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

function Field({ label, render }: { label: string; render: (id: string) => React.ReactNode }) {
	const id = useId();
	return (
		<div>
			<label htmlFor={id} className="block text-xs uppercase tracking-wide text-neutral-500 mb-1">
				{label}
			</label>
			{render(id)}
		</div>
	);
}
