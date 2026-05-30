import type { ReactNode } from 'react';
import { Icon } from './icons.tsx';

/** One crumb in a {@link Breadcrumbs} trail. */
export interface BreadcrumbItem {
	/** Display label. */
	readonly label: ReactNode;
	/** When provided, the crumb renders as a button invoking this handler. */
	readonly onClick?: () => void;
}

export interface BreadcrumbsProps {
	/** Ordered crumbs; the last one is treated as the current location. */
	readonly items: ReadonlyArray<BreadcrumbItem>;
}

/**
 * Drill-down breadcrumb trail. Crumbs with an `onClick` render as ghost
 * buttons; the trailing crumb is emphasised as the current location. Used by
 * the Explorer drill-down header.
 */
export const Breadcrumbs = ({ items }: BreadcrumbsProps) => (
	<div className="row wrap" style={{ gap: 6 }}>
		{items.map((item, i) => {
			const current = i === items.length - 1;
			const color = current ? 'var(--tx-hi)' : 'var(--tx-lo)';
			const fontWeight = current ? 540 : 500;
			return (
				<span key={i} className="row" style={{ gap: 6 }}>
					{i > 0 && <Icon name="chevR" size={13} style={{ color: 'var(--tx-dim)' }} />}
					{item.onClick ? (
						<button
							type="button"
							className="btn-ghost"
							onClick={item.onClick}
							style={{
								background: 'transparent',
								border: 'none',
								padding: 0,
								color,
								fontSize: 13,
								fontWeight,
							}}
						>
							{item.label}
						</button>
					) : (
						<span style={{ color, fontSize: 13, fontWeight }}>{item.label}</span>
					)}
				</span>
			);
		})}
	</div>
);
