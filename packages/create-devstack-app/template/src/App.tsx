import { useDevstackDeployed, useSignAndExecute } from '@mysten-incubation/devstack/react';
import { Card } from '@mysten-incubation/devstack/react/ui';
import { useCurrentAccount } from '@mysten/dapp-kit-react';
import { ConnectButton } from '@mysten/dapp-kit-react/ui';
import { Transaction } from '@mysten/sui/transactions';
import { useState } from 'react';
import { manifest } from 'virtual:devstack-manifest';

const helloPackage = manifest.registry?.packages?.find((p) => p.name === 'hello');
const helloPackageId = helloPackage?.packageId ?? '0x0';

export function App() {
	const deployed = useDevstackDeployed({ requirePackages: ['hello'] });
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
					<p className="text-xs text-neutral-500 leading-tight">starting point for a new app</p>
				</div>
				<ConnectButton />
			</header>

			<main className="flex-1 px-6 py-8 max-w-3xl mx-auto w-full space-y-6">
				{!deployed ? (
					<NotDeployed />
				) : (
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
				)}
			</main>
		</div>
	);
}

function NotDeployed() {
	return (
		<div className="text-center py-16">
			<h2 className="text-2xl font-semibold mb-3">No deployment found</h2>
			<p className="text-neutral-600 dark:text-neutral-400 max-w-md mx-auto">
				Run{' '}
				<code className="px-1.5 py-0.5 rounded bg-neutral-100 dark:bg-neutral-800 font-mono text-sm">
					pnpm dev
				</code>{' '}
				to bring up the localnet and publish the <code>hello</code> package.
			</p>
		</div>
	);
}
