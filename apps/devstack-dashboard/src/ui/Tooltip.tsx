import { useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';

export interface TooltipProps {
	/** Tooltip content shown on hover. */
	readonly label: ReactNode;
	/** The trigger element the tooltip wraps. */
	readonly children: ReactNode;
	/** Which side of the trigger to render on. Defaults to `top`. */
	readonly side?: 'top' | 'bottom';
}

/**
 * Hover tooltip wrapper. Shows `label` in a small elevated bubble above
 * (`side="top"`) or below (`side="bottom"`) the wrapped `children` while
 * hovered.
 */
export const Tooltip = ({ label, children, side = 'top' }: TooltipProps) => {
	const [show, setShow] = useState(false);
	const pos: CSSProperties =
		side === 'top'
			? { bottom: 'calc(100% + 7px)', left: '50%', transform: 'translateX(-50%)' }
			: { top: 'calc(100% + 7px)', left: '50%', transform: 'translateX(-50%)' };
	return (
		<span
			style={{ position: 'relative', display: 'inline-flex' }}
			onMouseEnter={() => setShow(true)}
			onMouseLeave={() => setShow(false)}
		>
			{children}
			{show && (
				<span
					style={{
						position: 'absolute',
						...pos,
						zIndex: 300,
						whiteSpace: 'nowrap',
						padding: '5px 9px',
						borderRadius: 6,
						background: 'var(--bg-elev-2)',
						border: '1px solid var(--line-strong)',
						boxShadow: 'var(--sh-2)',
						fontSize: 11.5,
						color: 'var(--tx-hi)',
						pointerEvents: 'none',
						animation: 'fadeIn .12s ease both',
					}}
				>
					{label}
				</span>
			)}
		</span>
	);
};
