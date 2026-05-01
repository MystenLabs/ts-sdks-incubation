import { useDevstackPackage, useDevstackSignAndExecute } from '@mysten-incubation/devstack/react';
import { useCurrentClient } from '@mysten/dapp-kit-react';
import { Transaction } from '@mysten/sui/transactions';
import { useId, useState } from 'react';

import { stringToBytes } from '../lib/format.js';
import { encryptForSealId, freshSealId } from '../lib/seal.js';
import { Card } from './Card.js';

export function UploadForm() {
	const client = useCurrentClient();
	const vault = useDevstackPackage('vault');
	const { mutateAsync, isPending } = useDevstackSignAndExecute({
		invalidateKeys: [['vault']],
	});

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

			const { hex: sealIdHex, bytes: sealIdBytes } = freshSealId();
			const data = stringToBytes(content);
			const encrypted = await encryptForSealId({ suiClient: client, sealIdHex, data });

			const tx = new Transaction();
			vault.uploadEntry({
				arguments: [name, Array.from(encrypted), Array.from(sealIdBytes)],
			})(tx);
			const result = await mutateAsync(tx);
			const txResult = result as {
				Transaction?: { digest?: string };
				FailedTransaction?: { digest?: string };
			};
			setLastDigest(txResult.Transaction?.digest ?? txResult.FailedTransaction?.digest ?? '');
		} catch (e) {
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
