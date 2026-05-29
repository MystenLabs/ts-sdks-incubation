import type { ReactNode } from 'react';

export interface DefRowProps {
	/** Left-hand key/label. */
	readonly label: ReactNode;
	/** Right-aligned value (any node). */
	readonly children: ReactNode;
}

/**
 * One key/value row inside a {@link DefList}: a dim label on the left and a
 * right-aligned value. The row separator is supplied by `DefList`'s container
 * styling, so rows compose cleanly without per-row "last" bookkeeping.
 */
export const DefRow = ({ label, children }: DefRowProps) => (
	<div className="row between" style={{ padding: '9px 0', gap: 12 }}>
		<span style={{ fontSize: 12.5, color: 'var(--tx-lo)' }}>{label}</span>
		<span style={{ textAlign: 'right', minWidth: 0 }}>{children}</span>
	</div>
);
