import { CurrentAccountSigner } from '@mysten/dapp-kit-core';
import { useCurrentAccount, useCurrentClient } from '@mysten/dapp-kit-react';
import { useMemo, useState } from 'react';

import { dAppKit } from '../dapp-kit.js';
import { readBlob, storeBlob } from '../lib/walrus.js';
import { Panel, PanelButton } from '../ui/Panel.js';

const enc = new TextEncoder();
const dec = new TextDecoder();

/**
 * Walrus panel: store a text blob via the connected wallet, surface the
 * SDK-assigned blob id, then read it back from the storage committee.
 */
export function WalrusPanel({ connected }: { connected: boolean }) {
	const account = useCurrentAccount();
	const client = useCurrentClient();

	// One signer per session — wraps the currently-connected dapp-kit
	// account so the walrus SDK registers + certifies blobs on chain the
	// same way it would on testnet/mainnet. CurrentAccountSigner is not
	// generic over the app's literal network tuple, so TS needs a boundary
	// cast even though the runtime shape is the same dapp-kit object.
	const signer = useMemo(
		() =>
			new CurrentAccountSigner(
				dAppKit as unknown as ConstructorParameters<typeof CurrentAccountSigner>[0],
			),
		[],
	);

	const [text, setText] = useState('stored on Walrus · localnet only');
	const [blobId, setBlobId] = useState<string | null>(null);
	const [readback, setReadback] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);

	async function onStore() {
		if (account === null) return;
		setError(null);
		setReadback(null);
		setBusy(true);
		try {
			const { blobId: id } = await storeBlob({
				suiClient: client,
				signer,
				data: enc.encode(text),
			});
			setBlobId(id);
		} catch (e) {
			setError((e as Error).message);
		} finally {
			setBusy(false);
		}
	}

	async function onRead() {
		if (blobId === null) return;
		setError(null);
		setBusy(true);
		try {
			const bytes = await readBlob({ suiClient: client, blobId });
			setReadback(dec.decode(bytes));
		} catch (e) {
			setError((e as Error).message);
		} finally {
			setBusy(false);
		}
	}

	const disabled = !connected || busy;

	return (
		<Panel
			title="Walrus"
			subtitle="Store a text blob, then read it back from the storage committee"
			connected={connected}
			error={error}
		>
			<div className="space-y-3">
				<label className="block text-xs text-neutral-500">
					Text
					<input
						type="text"
						value={text}
						onChange={(e) => setText(e.target.value)}
						className="mt-1 w-full rounded-md border border-neutral-300 dark:border-neutral-700 bg-transparent px-2 py-1 text-sm"
					/>
				</label>

				<PanelButton testid="walrus-store" disabled={disabled} onClick={onStore}>
					{busy && blobId === null ? 'Storing…' : 'Store blob'}
				</PanelButton>

				{blobId !== null && (
					<>
						<p className="text-xs text-neutral-500 break-all">
							Blob id:{' '}
							<span className="font-mono" data-testid="walrus-blob-id">
								{blobId}
							</span>
						</p>
						<PanelButton testid="walrus-read" disabled={disabled} onClick={onRead}>
							{busy ? 'Reading…' : 'Read back'}
						</PanelButton>
					</>
				)}

				{readback !== null && (
					<p className="text-sm">
						Read back:{' '}
						<span className="font-mono" data-testid="walrus-readback">
							{readback}
						</span>
					</p>
				)}
			</div>
		</Panel>
	);
}
