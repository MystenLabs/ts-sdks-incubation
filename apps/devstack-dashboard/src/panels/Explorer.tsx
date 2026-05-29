// Explorer panel — an honest stub. The page header + a global search input
// (non-functional, styled only), then an EmptyState. No chain data is
// fabricated; the local indexer isn't wired to the dashboard yet.

import { Icon, EmptyState } from '../ui/index.ts';
import type { PanelProps } from './types.ts';

export const ExplorerPanel = (_props: PanelProps) => (
	<div className="col" style={{ gap: 18 }}>
		<div className="row between wrap" style={{ gap: 12 }}>
			<div>
				<h2 style={{ fontSize: 19 }}>Explorer</h2>
				<p style={{ color: 'var(--tx-mid)', fontSize: 13, margin: '3px 0 0' }}>
					Browser-side explorer over the local node.
				</p>
			</div>
			<div
				className="row"
				style={{
					gap: 8,
					background: 'var(--bg-panel)',
					border: '1px solid var(--line)',
					borderRadius: 'var(--r-sm)',
					padding: '0 12px',
					height: 34,
					width: 320,
					maxWidth: '100%',
					opacity: 0.6,
				}}
			>
				<Icon name="search" size={15} style={{ color: 'var(--tx-lo)' }} />
				<input
					disabled
					placeholder="Digest · object · address · package…"
					style={{
						background: 'transparent',
						border: 'none',
						outline: 'none',
						color: 'var(--tx-hi)',
						fontSize: 12.5,
						flex: 1,
						fontFamily: 'var(--font-mono)',
					}}
				/>
			</div>
		</div>

		<div className="panel">
			<EmptyState
				icon="compass"
				title="Explorer coming soon"
				hint="The local indexer isn't wired to the dashboard yet."
			/>
		</div>
	</div>
);
