import { Card } from './ui/Card.js';
import { useCurrentAccount, useCurrentClient, useDAppKit } from '@mysten/dapp-kit-react';
import { ConnectButton } from '@mysten/dapp-kit-react/ui';
import { Transaction } from '@mysten/sui/transactions';
import { useMutation, useQueryClient, type UseMutationResult } from '@tanstack/react-query';
import { useState } from 'react';
import { packages } from './generated/packages.js';

// Codegen runs before Dev (`after: [..., codegen]`), so this file
// existing implies hello is published — no `isDeployed` guard needed.
const helloPackageId = packages.hello.packageId;

interface UseSignAndExecuteOptions {
	invalidateKeys?: ReadonlyArray<readonly unknown[]>;
}

function isFailedTransaction(
	result: unknown,
): result is { FailedTransaction: { status?: { error?: string | null } } } {
	if (typeof result !== 'object' || result === null) return false;
	if (!('FailedTransaction' in result)) return false;
	const ft = (result as { FailedTransaction?: unknown }).FailedTransaction;
	return typeof ft === 'object' && ft !== null;
}

function hasTransaction(result: unknown): result is { Transaction: { digest: string } } {
	if (typeof result !== 'object' || result === null) return false;
	if (!('Transaction' in result)) return false;
	const tx = (result as { Transaction?: unknown }).Transaction;
	return (
		typeof tx === 'object' &&
		tx !== null &&
		'digest' in tx &&
		typeof (tx as { digest?: unknown }).digest === 'string'
	);
}

function hasWaitForTransaction(
	client: unknown,
): client is { waitForTransaction: (a: { digest: string }) => Promise<unknown> } {
	if (typeof client !== 'object' || client === null) return false;
	if (!('waitForTransaction' in client)) return false;
	return typeof (client as { waitForTransaction?: unknown }).waitForTransaction === 'function';
}

function useSignAndExecute(
	options: UseSignAndExecuteOptions = {},
): UseMutationResult<{ digest: string }, Error, Transaction> {
	const dAppKit = useDAppKit();
	const client = useCurrentClient();
	const qc = useQueryClient();
	return useMutation<{ digest: string }, Error, Transaction>({
		mutationFn: async (transaction) => {
			const result = await dAppKit.signAndExecuteTransaction({ transaction });
			if (isFailedTransaction(result)) {
				throw new Error(result.FailedTransaction.status?.error ?? 'transaction failed');
			}
			if (!hasTransaction(result)) {
				throw new Error('signAndExecuteTransaction: missing Transaction in result');
			}
			return result.Transaction;
		},
		onSuccess: async (tx) => {
			if (hasWaitForTransaction(client) && tx.digest.length > 0) {
				await client.waitForTransaction({ digest: tx.digest });
			}
			await Promise.all(
				(options.invalidateKeys ?? []).map((key) => qc.invalidateQueries({ queryKey: key })),
			);
		},
	});
}

export function App() {
	const me = useCurrentAccount();
	const { mutateAsync, isPending } = useSignAndExecute();
	const [lastDigest, setLastDigest] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);

	async function onMint() {
		setError(null);
		try {
			const tx = new Transaction();
			const message = new TextEncoder().encode(`hello from ${me?.address ?? 'anon'}`);
			tx.moveCall({
				target: `${helloPackageId}::hello::mint`,
				arguments: [tx.pure.vector('u8', Array.from(message))],
			});
			const result = await mutateAsync(tx);
			setLastDigest(result.digest);
		} catch (e) {
			setError((e as Error).message);
		}
	}

	return (
		<div className="min-h-screen flex flex-col">
			<header className="flex items-center justify-between px-6 py-4 border-b border-neutral-200 dark:border-neutral-800 bg-white/50 dark:bg-neutral-950/50 backdrop-blur sticky top-0 z-10">
				<div>
					<h1 className="text-base font-semibold leading-tight">Devstack template</h1>
					<p className="text-xs text-neutral-500 leading-tight">
						{me ? (
							<>
								Connected as{' '}
								<span className="capitalize">{me.label ?? me.address.slice(0, 8)}</span>
							</>
						) : (
							'starting point for a new app'
						)}
					</p>
				</div>
				<ConnectButton />
			</header>

			<main className="flex-1 px-6 py-8 max-w-3xl mx-auto w-full space-y-6">
				<Card title="Greeting" subtitle="Calls hello::mint with the connected account as sender">
					<div className="space-y-3">
						<p className="text-xs text-neutral-500">
							Package:{' '}
							<span className="font-mono break-all" data-testid="package-id">
								{helloPackageId}
							</span>
						</p>
						<button
							type="button"
							data-testid="mint-button"
							disabled={!me || isPending}
							onClick={onMint}
							className="w-full rounded-md bg-emerald-600 hover:bg-emerald-700 disabled:bg-neutral-400 text-white text-sm font-medium py-2"
						>
							{isPending ? 'Submitting…' : me ? 'Send greeting' : 'Connect a wallet first'}
						</button>
						{error && (
							<p className="text-sm text-red-600 dark:text-red-400" data-testid="mint-error">
								{error}
							</p>
						)}
						{lastDigest && (
							<p className="text-xs text-neutral-500 break-all" data-testid="mint-tx">
								Last tx: <span className="font-mono">{lastDigest}</span>
							</p>
						)}
					</div>
				</Card>
			</main>
		</div>
	);
}
