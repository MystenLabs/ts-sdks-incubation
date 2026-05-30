import type { StatusToken } from '../lib/derive.ts';

export interface DotProps {
	/** Semantic color token driving the `.dot-<token>` class. */
	readonly token: StatusToken;
	/** When true, adds the `.dot-pulse` animation (in-flight states). */
	readonly pulse?: boolean;
	/** Extra classes appended after the dot classes. */
	readonly className?: string;
}

/**
 * Small semantic status dot. Colour and glow come from the `.dot-<token>`
 * classes defined in `index.css`; `pulse` opts into the breathing animation.
 */
export const Dot = ({ token, pulse, className = '' }: DotProps) => (
	<span className={`dot dot-${token} ${pulse ? 'dot-pulse' : ''} ${className}`.trimEnd()} />
);
