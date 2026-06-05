import { type StatusToken, statusDisplay } from '../lib/derive.ts';
import type { LifecycleStatus } from '../lib/types.ts';

/**
 * Resolve a semantic token to the matching CSS color variable. White maps to
 * `--c-white` and dim to `--tx-dim`; the chromatic tokens map to their `--c-*`.
 */
export const tokenColor = (token: StatusToken): string =>
	token === 'dim' ? 'var(--tx-dim)' : `var(--c-${token})`;

export interface StatusBadgeProps {
	/** Real lifecycle status; the badge derives token/label/pulse from it. */
	readonly status: LifecycleStatus;
	/** Slightly smaller label text for dense rows. */
	readonly sm?: boolean;
}

/**
 * Pill badge for a plugin/row lifecycle status. Derives its color token, label,
 * and pulse from the canonical `statusDisplay` helper.
 */
export const StatusBadge = ({ status, sm }: StatusBadgeProps) => {
	const { token, label, pulse } = statusDisplay(status);
	return (
		<span
			className="badge"
			style={{ borderColor: `color-mix(in oklab, var(--c-${token}) 32%, var(--line-strong))` }}
		>
			<span className={`dot dot-${token} ${pulse ? 'dot-pulse' : ''}`} />
			<span style={{ color: tokenColor(token), fontWeight: 560, fontSize: sm ? 11 : 11.5 }}>
				{label}
			</span>
		</span>
	);
};
