import type { ReactNode } from 'react';

import { Card } from './Card.js';

/**
 * Shared chrome for a demo panel. Wraps {@link Card} with a consistent
 * disabled/overlay treatment when the wallet is not connected and a
 * standard error slot, so each plugin panel only renders its own body.
 */
export function Panel({
	title,
	subtitle,
	connected,
	error,
	children,
}: {
	title: string;
	subtitle?: string;
	connected: boolean;
	error?: string | null;
	children: ReactNode;
}) {
	return (
		<Card title={title} subtitle={subtitle}>
			<div className="space-y-3">
				{!connected && (
					<p className="text-xs text-amber-600 dark:text-amber-400">
						Connect a wallet to use this panel.
					</p>
				)}
				<div className={connected ? '' : 'opacity-50 pointer-events-none'}>{children}</div>
				{error && (
					<p className="text-sm text-red-600 dark:text-red-400" data-testid="panel-error">
						{error}
					</p>
				)}
			</div>
		</Card>
	);
}

/** Standard primary action button used inside panels. */
export function PanelButton({
	testid,
	disabled,
	onClick,
	children,
}: {
	testid: string;
	disabled?: boolean;
	onClick: () => void;
	children: ReactNode;
}) {
	return (
		<button
			type="button"
			data-testid={testid}
			disabled={disabled}
			onClick={onClick}
			className="w-full rounded-md bg-emerald-600 hover:bg-emerald-700 disabled:bg-neutral-400 text-white text-sm font-medium py-2"
		>
			{children}
		</button>
	);
}
