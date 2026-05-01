import { useDevstackDeployed } from '@mysten-incubation/devstack/react';
import { useCurrentAccount } from '@mysten/dapp-kit-react';
import { ConnectButton } from '@mysten/dapp-kit-react/ui';

import { Balances } from './components/Balances.js';
import { SendForm } from './components/SendForm.js';
import { SwapForm } from './components/SwapForm.js';
import { deployment } from './generated/deployment.js';
import { labelFor, shortAddress } from './lib/format.js';

export function App() {
	const deployed = useDevstackDeployed();
	return (
		<div className="min-h-screen flex flex-col">
			<header className="flex items-center justify-between px-6 py-4 border-b border-neutral-200 dark:border-neutral-800 bg-white/50 dark:bg-neutral-950/50 backdrop-blur sticky top-0 z-10">
				<div className="flex items-center gap-3">
					<div className="w-8 h-8 rounded-lg bg-gradient-to-br from-emerald-400 to-violet-500" />
					<div>
						<h1 className="text-base font-semibold leading-tight">Wallet</h1>
						<p className="text-xs text-neutral-500 leading-tight">Sui dev-examples · localnet</p>
					</div>
				</div>
				<ConnectButton />
			</header>

			<main className="flex-1 px-6 py-8 max-w-3xl mx-auto w-full space-y-6">
				{!deployed ? <NotDeployed /> : <Deployed />}
			</main>

			<footer className="px-6 py-3 border-t border-neutral-200 dark:border-neutral-800 text-xs text-neutral-500">
				Phase 3 · scaffold-eth-2-style DX for Sui
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
					pnpm localnet:up
				</code>{' '}
				to start the local Sui network and fund alice / bob / carol.
			</p>
		</div>
	);
}

function Deployed() {
	const me = useCurrentAccount();

	return (
		<>
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
				/ <span className="font-mono">Dev: carol</span> wallet to start interacting.
			</p>
		</div>
	);
}

function ConnectedView({ address }: { address: string }) {
	const label = labelFor(address, deployment.accounts);

	return (
		<>
			<div className="rounded-xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900/50 px-5 py-3 flex items-center justify-between text-sm">
				<div>
					<span className="text-neutral-500">Connected as </span>
					<span className="font-medium capitalize">{label ?? 'unknown'}</span>
					<span className="ml-2 font-mono text-xs text-neutral-500">
						{shortAddress(address, 8, 6)}
					</span>
				</div>
			</div>
			<SendForm self={address} />
			<SwapForm self={address} />
		</>
	);
}
