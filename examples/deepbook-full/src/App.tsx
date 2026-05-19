import { useCurrentAccount } from '@mysten/dapp-kit-react';
import { ConnectButton } from '@mysten/dapp-kit-react/ui';

import { Health } from './components/Health.js';
import { Trading } from './components/Trading.js';
import { Mint } from './components/Mint.js';
import { Ticker } from './components/Ticker.js';
import { Balances } from './components/Balances.js';
import { deepbookConfig } from './generated/deepbook-config.js';

export function App() {
	const deployed = Object.keys(deepbookConfig.pools).length > 0;
	return (
		<div className="min-h-screen flex flex-col">
			<header className="flex items-center justify-between px-6 py-4 border-b border-neutral-200 dark:border-neutral-800 bg-white/50 dark:bg-neutral-950/50 backdrop-blur sticky top-0 z-10">
				<div className="flex items-center gap-3">
					<div className="w-8 h-8 rounded-lg bg-gradient-to-br from-sky-400 to-violet-500" />
					<div>
						<h1 className="text-base font-semibold leading-tight">DeepBook Full</h1>
						<p className="text-xs text-neutral-500 leading-tight">
							Pyth + indexer + server + margin · localnet
						</p>
					</div>
				</div>
				<ConnectButton />
			</header>

			<main className="flex-1 px-6 py-8 max-w-4xl mx-auto w-full space-y-6">
				{!deployed ? <NotDeployed /> : <Deployed />}
			</main>

			<footer className="px-6 py-3 border-t border-neutral-200 dark:border-neutral-800 text-xs text-neutral-500">
				deepbook-sandbox parity on Effect-Layer devstack
			</footer>
		</div>
	);
}

function NotDeployed() {
	return (
		<div className="text-center py-16">
			<h2 className="text-2xl font-semibold mb-3">No localnet running</h2>
			<p className="text-neutral-600 dark:text-neutral-400 max-w-md mx-auto">
				Run{' '}
				<code className="px-1.5 py-0.5 rounded bg-neutral-100 dark:bg-neutral-800 font-mono text-sm">
					pnpm dev
				</code>{' '}
				to bring up the full deepbook stack (sui + postgres + pyth + indexer + server).
			</p>
		</div>
	);
}

function Deployed() {
	const me = useCurrentAccount();
	return (
		<>
			<Health />
			<Ticker />
			{me ? <ConnectedView address={me.address} /> : <DisconnectedView />}
			<Balances />
		</>
	);
}

function DisconnectedView() {
	return (
		<div className="rounded-xl border border-dashed border-neutral-300 dark:border-neutral-700 px-5 py-6 text-center">
			<p className="text-sm text-neutral-600 dark:text-neutral-300">
				Click <strong>Connect Wallet</strong> in the top-right and pick a{' '}
				<span className="font-mono">Dev: alice</span> / <span className="font-mono">Dev: bob</span>{' '}
				wallet to start interacting.
			</p>
		</div>
	);
}

function ConnectedView({ address }: { address: string }) {
	return (
		<>
			<Mint self={address} />
			<Trading self={address} />
		</>
	);
}
