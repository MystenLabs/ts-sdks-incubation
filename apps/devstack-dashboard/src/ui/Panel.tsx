import type { CSSProperties, ReactNode } from 'react';

export interface PanelProps {
	/** Panel body. */
	readonly children: ReactNode;
	/** When true, applies `.panel-pad` interior padding to the body. */
	readonly pad?: boolean;
	/** Optional header rendered above the body inside the same surface. */
	readonly header?: ReactNode;
	/** Extra classes appended after the base `panel` class. */
	readonly className?: string;
	/** Inline style passthrough. */
	readonly style?: CSSProperties;
}

/**
 * Base elevated surface. Renders a `.panel` (adding `.panel-pad` to the body
 * when `pad`), with an optional `header` block above the body. When a header is
 * present on an unpadded panel the surface clips its corners so the header rule
 * stays inside the rounded edge.
 */
export const Panel = ({ children, pad, header, className = '', style }: PanelProps) => (
	<div
		className={`panel ${className}`.trimEnd()}
		style={{ overflow: header && !pad ? 'hidden' : undefined, ...style }}
	>
		{header && (
			<div className="panel-pad" style={{ padding: '14px 18px', paddingBottom: pad ? 0 : 14 }}>
				{header}
			</div>
		)}
		{pad ? (
			<div className="panel-pad" style={header ? { paddingTop: 0 } : undefined}>
				{children}
			</div>
		) : (
			children
		)}
	</div>
);
