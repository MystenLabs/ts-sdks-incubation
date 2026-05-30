import type { AccountProjection } from '../lib/types.ts';
import { fundingDisplay } from '../lib/derive.ts';
import { Dot } from './Dot.tsx';

export interface FundingStatusProps {
	/** The account's funding sub-projection (status + balances). */
	readonly funding: AccountProjection['funding'];
}

/**
 * Funding cell: a semantic {@link Dot} plus a colored label, derived from the
 * account's funding status via `fundingDisplay`. The `funded` state gains a
 * leading check glyph and the in-flight `pending` state pulses.
 */
export const FundingStatus = ({ funding }: FundingStatusProps) => {
	const { label, token } = fundingDisplay(funding.status);
	const display = funding.status === 'funded' ? `✓ ${label}` : label;
	return (
		<span className="row" style={{ gap: 6 }}>
			<Dot token={token} pulse={funding.status === 'pending'} />
			<span style={{ fontSize: 12, color: `var(--c-${token})` }}>{display}</span>
		</span>
	);
};
