import type { ReactNode } from 'react';

export interface DefListProps {
	/** A sequence of {@link DefRow} elements. */
	readonly children: ReactNode;
	/** Extra classes appended after the base layout classes. */
	readonly className?: string;
}

/**
 * Container for a stack of {@link DefRow} key/value rows. Draws a faint divider
 * between adjacent rows (and never above the first or below the last) via the
 * `[&>*+*]` adjacent-sibling border, so callers compose rows without tracking
 * which one is last.
 */
export const DefList = ({ children, className = '' }: DefListProps) => (
	<div className={`col [&>*+*]:border-t [&>*+*]:border-line-faint ${className}`.trimEnd()}>
		{children}
	</div>
);
