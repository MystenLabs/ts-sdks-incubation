import { useCurrentAccount } from '@mysten/dapp-kit-react';
import { ConnectButton } from '@mysten/dapp-kit-react/ui';
import type { ComponentType } from 'react';

import { CounterPanel } from './panels/CounterPanel.js';
// devstack:begin deepbook
import { DeepbookPanel } from './panels/DeepbookPanel.js';
// devstack:end deepbook
// devstack:begin seal
import { SealPanel } from './panels/SealPanel.js';
// devstack:end seal
// devstack:begin walrus
import { WalrusPanel } from './panels/WalrusPanel.js';
// devstack:end walrus

// Panel registry. Core CounterPanel is always present; optional plugin
// panels are fenced so the scaffolder can strip the ones a user opts out
// of. Each panel takes a single `connected` prop.
const panels: ReadonlyArray<ComponentType<{ connected: boolean }>> = [
	CounterPanel,
	// devstack:begin deepbook
	DeepbookPanel,
	// devstack:end deepbook
	// devstack:begin seal
	SealPanel,
	// devstack:end seal
	// devstack:begin walrus
	WalrusPanel,
	// devstack:end walrus
];

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
				{panels.map((PanelComponent, index) => (
					<PanelComponent key={index} connected={connected} />
				))}
			</main>
		</div>
	);
}
