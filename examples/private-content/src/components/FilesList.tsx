import { useCurrentClient, useCurrentNetwork } from '@mysten/dapp-kit-react';
import { useState } from 'react';

import { bytesToString, shortAddress } from '../lib/format.js';
import { type VaultCap, useFile, useOwnedCaps } from '../lib/queries.js';
import { decryptForFile } from '../lib/seal.js';
import { readBlob } from '../lib/walrus.js';
import { Card } from '../ui/Card.js';

export function FilesList({ self }: { self: string }) {
	const caps = useOwnedCaps(self);
	const items = caps.data ?? [];

	return (
		<Card
			title="My files"
			subtitle="Each Cap you hold gates decrypt access to one File on-chain"
			right={
				<button
					type="button"
					className="text-xs text-neutral-500 hover:text-neutral-800 dark:hover:text-neutral-200"
					onClick={() => caps.refetch()}
				>
					Refresh
				</button>
			}
		>
			{caps.isLoading && <p className="text-sm text-neutral-500">Loading…</p>}
			{!caps.isLoading && items.length === 0 && (
				<p className="text-sm text-neutral-500">
					No files yet. Upload one above, or ask another account to grant you a cap.
				</p>
			)}
			<ul className="divide-y divide-neutral-200 dark:divide-neutral-800">
				{items.map((cap) => (
					<FileRow key={cap.id} cap={cap} self={self} />
				))}
			</ul>
		</Card>
	);
}

function FileRow({ cap, self }: { cap: VaultCap; self: string }) {
	const client = useCurrentClient();
	const network = useCurrentNetwork();
	const file = useFile(cap.fileId);
	const [plaintext, setPlaintext] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);

	async function onDecrypt() {
		if (!file.data) return;
		setError(null);
		setBusy(true);
		try {
			const encrypted = await readBlob({ suiClient: client, network, blobId: file.data.blobId });
			const bytes = await decryptForFile({
				suiClient: client,
				network,
				address: self,
				fileId: file.data.id,
				sealIdHex: file.data.sealIdHex,
				encrypted,
			});
			setPlaintext(bytesToString(bytes));
		} catch (e) {
			setError((e as Error).message);
		} finally {
			setBusy(false);
		}
	}

	if (file.isLoading) {
		return (
			<li className="py-3 text-sm text-neutral-500">
				<span className="font-mono">{shortAddress(cap.fileId)}</span> · loading…
			</li>
		);
	}
	const f = file.data;
	if (!f) {
		return (
			<li className="py-3 text-sm text-neutral-500">
				<span className="font-mono">{shortAddress(cap.fileId)}</span> · not found
			</li>
		);
	}
	const ownerLabel = shortAddress(f.owner);

	return (
		<li className="py-3 space-y-2" data-testid={`file-row-${f.name}`}>
			<div className="flex items-baseline justify-between gap-3">
				<div>
					<span className="text-sm font-medium">{f.name}</span>
					<span className="ml-2 text-xs text-neutral-500">
						owner: <span className="font-mono">{ownerLabel}</span> · walrus blob{' '}
						<span className="font-mono">{shortAddress(f.blobId, 6, 4)}</span>
					</span>
				</div>
				<button
					type="button"
					onClick={onDecrypt}
					disabled={busy}
					data-testid={`decrypt-${f.name}`}
					className="rounded-md bg-emerald-600 hover:bg-emerald-700 disabled:bg-neutral-400 text-white text-xs font-medium px-3 py-1"
				>
					{busy ? 'Decrypting…' : 'Decrypt'}
				</button>
			</div>
			<p className="text-xs text-neutral-500 font-mono break-all">{f.id}</p>
			{plaintext !== null && (
				<pre
					className="rounded-md bg-neutral-100 dark:bg-neutral-800 px-3 py-2 text-xs font-mono whitespace-pre-wrap break-words"
					data-testid={`plaintext-${f.name}`}
				>
					{plaintext}
				</pre>
			)}
			{error && (
				<p
					className="text-xs text-red-600 dark:text-red-400"
					data-testid={`decrypt-error-${f.name}`}
				>
					{error}
				</p>
			)}
		</li>
	);
}
