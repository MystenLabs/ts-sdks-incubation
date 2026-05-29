import type { CSSProperties, ReactNode } from 'react';

export interface BadgeProps {
	/** Badge contents. */
	readonly children: ReactNode;
	/** Extra classes appended after the base `.badge` class. */
	readonly className?: string;
	/** Inline style overrides (the handoff tweaks height/color per-use). */
	readonly style?: CSSProperties;
}

/**
 * The `.badge` pill primitive. Callers tune height/color/size via `style`,
 * matching the design handoff's inline-override usage.
 */
export const Badge = ({ children, className = '', style }: BadgeProps) => (
	<span className={`badge ${className}`.trimEnd()} style={style}>
		{children}
	</span>
);
