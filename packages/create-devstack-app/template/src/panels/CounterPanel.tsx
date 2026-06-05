import { useCurrentClient } from '@mysten/dapp-kit-react';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';

import { createCounterTx, incrementTx, readCounter } from '../lib/counter.js';
import { useSignAndExecute, waitForCreatedObjectId } from '../lib/sign.js';
import { Panel, PanelButton } from '../ui/Panel.js';

/**
 * Core panel: create a shared Counter, increment it, and read the value
 * back over the generated bindings. The Counter's object id lives in
 * React state (no `capture:` needed in the stack).
 */
export function CounterPanel({ connected }: { connected: boolean }) {
	const client = useCurrentClient();
	const { mutateAsync, isPending } = useSignAndExecute();
	const [counterId, setCounterId] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);

	const valueQuery = useQuery({
		queryKey: ['counter', 'value', counterId],
		queryFn: () => (counterId === null ? null : readCounter(client, counterId)),
		enabled: counterId !== null,
		refetchInterval: counterId === null ? false : 1_500,
	});

	async function onCreate() {
		setError(null);
		try {
			const { digest } = await mutateAsync(createCounterTx());
			const createdId = await waitForCreatedObjectId(client, digest);
			if (createdId === null) {
				throw new Error('create_and_share did not return a created Counter object');
			}
			setCounterId(createdId);
		} catch (e) {
			setError((e as Error).message);
		}
	}

	async function onIncrement() {
		if (counterId === null) return;
		setError(null);
		try {
			await mutateAsync(incrementTx(counterId));
			await valueQuery.refetch();
		} catch (e) {
			setError((e as Error).message);
		}
	}

	const value = valueQuery.data ?? null;

	return (
		<Panel
			title="Counter"
			subtitle="Create a shared Counter, then increment it on chain"
			connected={connected}
			error={error}
		>
			<div className="space-y-3">
				<p className="text-xs text-neutral-500">
					Package: <span className="font-mono break-all">@local/counter</span> (resolved via
					dapp-kit MVR override)
				</p>

				<PanelButton testid="counter-create" disabled={!connected || isPending} onClick={onCreate}>
					{counterId === null ? 'Create counter' : 'Create another counter'}
				</PanelButton>

				{counterId !== null && (
					<>
						<p className="text-xs text-neutral-500 break-all">
							Counter:{' '}
							<span className="font-mono" data-testid="counter-id">
								{counterId}
							</span>
						</p>
						<PanelButton
							testid="counter-increment"
							disabled={!connected || isPending}
							onClick={onIncrement}
						>
							{isPending ? 'Submitting…' : 'Increment'}
						</PanelButton>
						<p className="text-sm">
							Value:{' '}
							<span className="font-mono" data-testid="counter-value">
								{value === null ? '…' : value.toString()}
							</span>
						</p>
					</>
				)}
			</div>
		</Panel>
	);
}
