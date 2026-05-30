import { Icon, type IconName } from './icons.tsx';

export interface EmptyStateProps {
	/** Icon shown in the centred tile. Defaults to "box". */
	readonly icon?: IconName;
	/** Primary message. */
	readonly title: string;
	/** Optional secondary hint text. */
	readonly hint?: string;
}

/**
 * Centred empty-state placeholder: a framed icon tile, a title, and an optional
 * hint, for sections with no data.
 */
export const EmptyState = ({ icon = 'box', title, hint }: EmptyStateProps) => (
	<div
		className="col"
		style={{
			alignItems: 'center',
			justifyContent: 'center',
			padding: '48px 20px',
			textAlign: 'center',
			color: 'var(--tx-lo)',
		}}
	>
		<div
			style={{
				width: 46,
				height: 46,
				borderRadius: 12,
				display: 'grid',
				placeItems: 'center',
				background: 'var(--bg-elev)',
				border: '1px solid var(--line)',
				marginBottom: 14,
			}}
		>
			<Icon name={icon} size={20} />
		</div>
		<div style={{ color: 'var(--tx-mid)', fontWeight: 540, marginBottom: 4 }}>{title}</div>
		{hint && <div style={{ fontSize: 12.5, maxWidth: 320 }}>{hint}</div>}
	</div>
);
