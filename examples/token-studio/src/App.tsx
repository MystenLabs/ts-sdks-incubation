import { useCurrentAccount, useCurrentNetwork, useCurrentWallet } from '@mysten/dapp-kit-react';
import { ConnectButton } from '@mysten/dapp-kit-react/ui';

import { Balances } from './components/Balances.js';
import { CoinHeader } from './components/CoinHeader.js';
import { MintForm } from './components/MintForm.js';
import { TransferForm } from './components/TransferForm.js';
import { deployment, isDeployed } from './lib/deployment.js';
import { shortAddress } from './lib/coin.js';
import { useTreasuryCapOwner } from './lib/queries.js';

export function App() {
	const deployed = isDeployed;
	// Active network label comes from dapp-kit (the connected client's
	// network), not from the generated config — app code never reads
	// `config.network` directly.
	const network = useCurrentNetwork();
	return (
		<div className="min-h-screen flex flex-col">
			<header className="flex items-center justify-between px-6 py-4 border-b border-neutral-200 dark:border-neutral-800 bg-white/50 dark:bg-neutral-950/50 backdrop-blur sticky top-0 z-10">
				<div className="flex items-center gap-3">
					<div className="w-8 h-8 rounded-lg bg-gradient-to-br from-sky-400 to-indigo-500" />
					<div>
						<h1 className="text-base font-semibold leading-tight">Token Studio</h1>
						<p className="text-xs text-neutral-500 leading-tight">Sui dev-examples · {network}</p>
					</div>
				</div>
				<ConnectButton />
			</header>

			<main className="flex-1 px-6 py-8 max-w-6xl mx-auto w-full space-y-6">
				{!deployed ? <NotDeployed /> : <Deployed />}
			</main>

			<footer className="px-6 py-3 border-t border-neutral-200 dark:border-neutral-800 text-xs text-neutral-500">
				scaffold-eth-2-style DX for Sui · {shortAddress(deployment.packageId)}
			</footer>
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
					pnpm localnet:up
				</code>{' '}
				to publish the <code>managed_coin</code> package against the local Sui network.
			</p>
		</div>
	);
}

function Deployed() {
	const me = useCurrentAccount();

	return (
		<>
			<CoinHeader />
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
	// The connected wallet exposes its accounts (in DEV the seeded dev-wallet
	// accounts alice/bob/carol), each carrying a `label` = the devstack name.
	const wallet = useCurrentWallet();
	const label = wallet?.accounts.find((a) => a.address === address)?.label ?? null;
	// Determine the ACTUAL TreasuryCap holder by ownership, not wallet order:
	// query the on-chain owner of the known treasuryCapId. The connected account
	// is the holder iff its address matches that owner. While the owner is still
	// loading (`undefined`) we DON'T show Mint — keying off wallet order would
	// mis-flag every account on a single-account production wallet, and would
	// transiently mis-flag during a `connectAs` narrow phase.
	const { data: treasuryOwner } = useTreasuryCapOwner();
	const isTreasuryHolder = treasuryOwner != null && address === treasuryOwner;

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
				{isTreasuryHolder && (
					<span className="text-xs px-2 py-0.5 rounded bg-amber-100 dark:bg-amber-900/40 text-amber-800 dark:text-amber-300">
						TreasuryCap holder
					</span>
				)}
			</div>

			<div className="grid gap-6 md:grid-cols-2">
				{isTreasuryHolder && <MintForm />}
				<TransferForm self={address} />
			</div>
		</>
	);
}
