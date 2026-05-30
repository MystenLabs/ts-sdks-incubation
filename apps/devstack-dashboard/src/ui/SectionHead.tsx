import type { ReactNode } from 'react';

export interface SectionHeadProps {
	/** Section title (heading text or node). */
	readonly title: ReactNode;
	/** Optional count badge shown beside the title. */
	readonly count?: number;
	/** Optional right-aligned content (actions, filters). */
	readonly right?: ReactNode;
}

/**
 * Section header row: a title, an optional count badge, and an optional
 * right-aligned slot for controls.
 */
export const SectionHead = ({ title, count, right }: SectionHeadProps) => (
	<div className="row between" style={{ marginBottom: 12 }}>
		<div className="row" style={{ gap: 9 }}>
			<h3 style={{ fontSize: 14.5 }}>{title}</h3>
			{count != null && (
				<span className="badge" style={{ height: 19, fontSize: 11, color: 'var(--tx-mid)' }}>
					{count}
				</span>
			)}
		</div>
		{right}
	</div>
);
