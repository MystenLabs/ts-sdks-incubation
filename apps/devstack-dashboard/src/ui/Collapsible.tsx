import { useState } from 'react';
import type { ReactNode } from 'react';
import { Icon } from './icons.tsx';

export interface CollapsibleProps {
	/** Disclosure title shown beside the chevron toggle. */
	readonly title: ReactNode;
	/** Whether the section starts expanded. Defaults to collapsed. */
	readonly defaultOpen?: boolean;
	/** Body revealed when expanded. */
	readonly children: ReactNode;
}

/**
 * Disclosure surface: a full-width header button that toggles a chevron and
 * reveals/hides its body. Wraps the content in a `.panel` so collapsible
 * sections read as their own surface.
 */
export const Collapsible = ({ title, defaultOpen = false, children }: CollapsibleProps) => {
	const [open, setOpen] = useState(defaultOpen);
	return (
		<div className="panel" style={{ overflow: 'hidden' }}>
			<button
				type="button"
				className="row between"
				onClick={() => setOpen((o) => !o)}
				style={{
					width: '100%',
					padding: '12px 16px',
					background: 'transparent',
					border: 'none',
					cursor: 'pointer',
					gap: 10,
				}}
			>
				<span className="row" style={{ gap: 9 }}>
					<Icon name={open ? 'chevD' : 'chevR'} size={15} style={{ color: 'var(--tx-lo)' }} />
					<span style={{ fontWeight: 540, fontSize: 13.5, color: 'var(--tx-hi)' }}>{title}</span>
				</span>
			</button>
			{open && (
				<div
					className="panel-pad fade-up"
					style={{ paddingTop: 0, borderTop: '1px solid var(--line-faint)' }}
				>
					<div style={{ paddingTop: 14 }}>{children}</div>
				</div>
			)}
		</div>
	);
};
