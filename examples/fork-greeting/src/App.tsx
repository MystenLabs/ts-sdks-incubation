// Fork-greeting frontend. Two affordances:
//   1. Post a greeting (calls `board::post` against the shared Board)
//   2. Show the latest greeting (polls `getObject(boardId)`)
//
// The Board's id comes from the generated `captured.greeting.boardId`
// (emitted by `Codegen` via `PackageWithCapture({capture})`). Polling
// vs. event-subscription is the pragmatic choice for now — Phase 5 §9
// covers the subscription upgrade.

import { useCurrentAccount, useCurrentClient, useDAppKit } from '@mysten/dapp-kit-react';
import { ConnectButton } from '@mysten/dapp-kit-react/ui';
import { Transaction } from '@mysten/sui/transactions';
import {
	useMutation,
	useQuery,
	useQueryClient,
	type UseMutationResult,
} from '@tanstack/react-query';
import { useState } from 'react';

import { Card } from './ui/Card.js';
import { captured } from './generated/captured.js';
import { packages } from './generated/packages.js';

// Codegen runs before Dev (`needs: [..., codegen]`), so this file
// existing implies greeting is published — no `isDeployed` guard
// needed. The packageId + boardId both come out of the publish path:
// `packageId` from the publish receipt directly, `boardId` from the
// `PackageWithCapture({capture: {boardId: '::board::Board'}})` filter
// applied to objectChanges.
const greetingPackageId = packages.greeting.id;
const boardId: string | undefined = (captured as { greeting?: { boardId?: string } }).greeting
	?.boardId;

interface BoardState {
	readonly greeter: string;
	readonly latest: string;
	readonly count: number;
}

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

// Poll the shared Board for its latest fields. 1.5s cadence matches
// arena's `useGame` — fast enough that the e2e doesn't wait long, slow
// enough that an open browser tab isn't a DoS source.
function useBoard(id: string | undefined) {
	const client = useCurrentClient();
	return useQuery<BoardState | null>({
		queryKey: ['greeting', 'board', id],
		queryFn: async () => {
			if (!id) return null;
			const result = await client.core.getObject({ objectId: id, include: { content: true } });
			const content = result.object.content as
				| { fields?: { greeter?: string; latest?: string; count?: string | number } }
				| undefined;
			const fields = content?.fields ?? {};
			return {
				greeter: typeof fields.greeter === 'string' ? fields.greeter : '0x0',
				latest: typeof fields.latest === 'string' ? fields.latest : '',
				count:
					typeof fields.count === 'number'
						? fields.count
						: typeof fields.count === 'string'
							? Number(fields.count)
							: 0,
			};
		},
		enabled: !!id,
		refetchInterval: 1500,
	});
}

export function App() {
	const me = useCurrentAccount();
	const board = useBoard(boardId);
	const { mutateAsync, isPending } = useSignAndExecute({
		invalidateKeys: [['greeting', 'board', boardId]],
	});
	const [draft, setDraft] = useState('hello, fork');
	const [lastDigest, setLastDigest] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);

	async function onPost() {
		setError(null);
		if (!boardId) {
			setError('boardId missing from generated/captured.ts — run devstack apply first');
			return;
		}
		try {
			const tx = new Transaction();
			tx.moveCall({
				target: `${greetingPackageId}::board::post`,
				arguments: [
					tx.object(boardId),
					tx.pure.vector('u8', Array.from(new TextEncoder().encode(draft))),
				],
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
				<div className="flex items-center gap-3">
					<div className="w-8 h-8 rounded-lg bg-gradient-to-br from-emerald-500 to-cyan-400" />
					<div>
						<h1 className="text-base font-semibold leading-tight">fork-greeting</h1>
						<p className="text-xs text-neutral-500 leading-tight">
							{me ? (
								<>
									Connected as{' '}
									<span className="capitalize">{me.label ?? me.address.slice(0, 8)}</span>
								</>
							) : (
								'sui-fork harness · post + read a shared greeting'
							)}
						</p>
					</div>
				</div>
				<ConnectButton />
			</header>

			<main className="flex-1 px-6 py-8 max-w-2xl mx-auto w-full space-y-6">
				<Card title="Latest greeting" subtitle="Polled from the shared Board object every 1.5s">
					<div className="space-y-3">
						<p className="text-xs text-neutral-500">
							Board:{' '}
							<span className="font-mono break-all" data-testid="board-id">
								{boardId ?? '(unset)'}
							</span>
						</p>
						<p className="text-xs text-neutral-500">
							Greetings posted:{' '}
							<span className="font-mono" data-testid="board-count">
								{board.data?.count ?? 0}
							</span>
						</p>
						<div className="rounded-md border border-neutral-200 dark:border-neutral-800 px-3 py-2 bg-neutral-50 dark:bg-neutral-900/50">
							<p className="text-sm break-words min-h-[1.5rem]" data-testid="board-latest">
								{board.data?.latest || <span className="text-neutral-400">(none yet)</span>}
							</p>
							<p className="text-[10px] text-neutral-500 mt-1">
								by{' '}
								<span className="font-mono" data-testid="board-greeter">
									{board.data?.greeter ?? '0x0'}
								</span>
							</p>
						</div>
					</div>
				</Card>

				<Card title="Post a greeting" subtitle="Submits `board::post` from the connected account">
					<div className="space-y-3">
						<input
							type="text"
							value={draft}
							onChange={(e) => setDraft(e.target.value)}
							placeholder="hello, fork"
							maxLength={140}
							data-testid="greeting-input"
							className="w-full rounded-md border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-950 px-3 py-2 text-sm font-mono"
						/>
						<button
							type="button"
							data-testid="post-button"
							disabled={!me || isPending || !boardId}
							onClick={onPost}
							className="w-full rounded-md bg-emerald-600 hover:bg-emerald-700 disabled:bg-neutral-400 text-white text-sm font-medium py-2"
						>
							{isPending ? 'Submitting…' : me ? 'Send greeting' : 'Connect a wallet first'}
						</button>
						{error && (
							<p className="text-sm text-red-600 dark:text-red-400" data-testid="post-error">
								{error}
							</p>
						)}
						{lastDigest && (
							<p className="text-xs text-neutral-500 break-all" data-testid="post-tx">
								Last tx: <span className="font-mono">{lastDigest}</span>
							</p>
						)}
					</div>
				</Card>
			</main>

			<footer className="px-6 py-3 border-t border-neutral-200 dark:border-neutral-800 text-xs text-neutral-500">
				sui-fork · shared-object greeting
			</footer>
		</div>
	);
}
