import { useCurrentAccount } from '@mysten/dapp-kit-react';
import { ConnectButton } from '@mysten/dapp-kit-react/ui';

import { PANELS } from './app-panels.js';

export function App() {
	const me = useCurrentAccount();
	const connected = me !== null;

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
				{PANELS.map((PanelComponent, index) => (
					<PanelComponent key={index} connected={connected} />
				))}
			</main>
		</div>
	);
}
