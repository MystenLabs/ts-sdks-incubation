import type { StatusToken } from '../lib/derive.ts';

export interface MeterProps {
	/** Fill fraction in the range 0..1 (clamped). */
	readonly value: number;
	/** Semantic color token for the fill. Defaults to the accent color. */
	readonly token?: StatusToken;
}

/**
 * Horizontal proportion bar. Renders the `.meter` track with an inner fill
 * sized to `value` (0..1, clamped) and colored by `token` — falling back to the
 * theme accent when no token is given.
 */
export const Meter = ({ value, token }: MeterProps) => {
	const pct = `${Math.max(0, Math.min(1, value)) * 100}%`;
	return (
		<div className="meter">
			<span style={{ width: pct, background: token ? `var(--c-${token})` : 'var(--accent)' }} />
		</div>
	);
};
