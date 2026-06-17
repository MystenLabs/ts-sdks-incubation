import { useCurrentAccount, useCurrentClient, useDAppKit } from '@mysten/dapp-kit-react';
import { ConnectButton } from '@mysten/dapp-kit-react/ui';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';

import { createCounterTx, incrementTx, readCounter } from './counter.js';
import { executedTx } from './tx.js';

export function App() {
	const dAppKit = useDAppKit();
	const client = useCurrentClient();
	const account = useCurrentAccount();
	const connected = account !== null;

	const [counterId, setCounterId] = useState<string | null>(null);
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const value = useQuery({
		queryKey: ['counter', counterId],
		queryFn: () => (counterId === null ? null : readCounter(client, counterId)),
		enabled: counterId !== null,
		refetchInterval: counterId === null ? false : 1_500,
	});

	async function submit(action: () => Promise<void>) {
		setError(null);
		setPending(true);
		try {
			await action();
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			setPending(false);
		}
	}

	const onCreate = () =>
		submit(async () => {
			const result = await dAppKit.signAndExecuteTransaction({ transaction: createCounterTx() });
			const { digest, createdId } = executedTx(result);
			if (createdId === undefined) throw new Error('create_and_share created no object');
			// Wait for indexing so the first value read sees the new Counter.
			await client.waitForTransaction({ digest });
			setCounterId(createdId);
		});

	const onIncrement = () =>
		submit(async () => {
			if (counterId === null) return;
			const result = await dAppKit.signAndExecuteTransaction({
				transaction: incrementTx(counterId),
			});
			await client.waitForTransaction({ digest: executedTx(result).digest });
			await value.refetch();
		});

	return (
		<div className="shell">
			<header className="topbar">
				<div>
					<h1>Counter</h1>
					<p className="muted">
						{account
							? `Connected as ${account.label ?? account.address.slice(0, 10)}`
							: 'Connect a wallet to begin'}
					</p>
				</div>
				<ConnectButton />
			</header>

			<main className="panel">
				<p className="muted">
					A shared on-chain counter from <code>move/counter</code>, driven through the generated
					bindings in <code>src/generated/</code>.
				</p>

				<button disabled={!connected || pending} onClick={onCreate}>
					{counterId === null ? 'Create counter' : 'Create another counter'}
				</button>

				{counterId !== null && (
					<>
						<p className="muted mono">{counterId}</p>
						<div className="row">
							<button disabled={!connected || pending} onClick={onIncrement}>
								{pending ? 'Submitting…' : 'Increment'}
							</button>
							<span className="value mono">{value.data?.toString() ?? '…'}</span>
						</div>
					</>
				)}

				{error !== null && <p className="error">{error}</p>}
			</main>
		</div>
	);
}
