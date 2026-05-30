import type { ReactNode } from 'react';
import type { StatusToken } from '../lib/derive.ts';
import { Icon, type IconName } from './icons.tsx';

export interface KpiProps {
	/** Small eyebrow label above the value. */
	readonly label: string;
	/** The primary metric value. */
	readonly value: ReactNode;
	/** Optional dimmed sub-text beside the value. */
	readonly sub?: ReactNode;
	/** Optional semantic token tinting the value + icon. */
	readonly token?: StatusToken;
	/** When true, overlays the animated `.live-sweep` shimmer. */
	readonly live?: boolean;
	/** Optional corner icon. */
	readonly icon?: IconName;
}

/**
 * Headline metric tile. Renders inside a padded panel with an optional live
 * sweep overlay; the value and icon pick up `--c-<token>` when a token is set.
 */
export const Kpi = ({ label, value, sub, token, live, icon }: KpiProps) => (
	<div
		className="panel panel-pad fade-up"
		style={{ position: 'relative', overflow: 'hidden', minWidth: 0 }}
	>
		{live && (
			<div
				className="live-sweep"
				style={{ position: 'absolute', inset: 0, opacity: 0.5, pointerEvents: 'none' }}
			/>
		)}
		<div className="row between" style={{ marginBottom: 10 }}>
			<span className="eyebrow">{label}</span>
			{icon && (
				<Icon
					name={icon}
					size={15}
					style={{ color: token ? `var(--c-${token})` : 'var(--tx-lo)' }}
				/>
			)}
		</div>
		<div className="row" style={{ gap: 8, alignItems: 'baseline' }}>
			<span
				className="tnum"
				style={{
					fontSize: 26,
					fontWeight: 600,
					letterSpacing: '-.02em',
					color: token ? `var(--c-${token})` : 'var(--tx-hi)',
				}}
			>
				{value}
			</span>
			{sub && <span style={{ color: 'var(--tx-lo)', fontSize: 12.5 }}>{sub}</span>}
		</div>
	</div>
);
