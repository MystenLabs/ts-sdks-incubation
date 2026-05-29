import { mistToSui } from '../lib/format.ts';

export interface CoinAmountProps {
	/** Amount in MIST; `null` renders the formatter's em-dash placeholder. */
	readonly mist: string | number | bigint | null;
	/** Coin symbol rendered after the value. Defaults to "SUI". */
	readonly symbol?: string;
	/** Decimal places of the coin. Defaults to 9 (SUI). */
	readonly decimals?: number;
}

/**
 * Monospaced, tabular coin amount with a dimmed symbol suffix. Uses the
 * canonical `mistToSui` formatter for the default 9-decimal SUI case; other
 * decimal scales are rescaled to 9 decimals before formatting so the shared
 * bigint formatter can be reused.
 */
export const CoinAmount = ({ mist, symbol = 'SUI', decimals = 9 }: CoinAmountProps) => {
	const text = formatAmount(mist, decimals);
	return (
		<span className="mono tnum" style={{ fontSize: 13 }}>
			{text} <span style={{ color: 'var(--tx-lo)', fontSize: 11.5 }}>{symbol}</span>
		</span>
	);
};

const formatAmount = (mist: string | number | bigint | null, decimals: number): string => {
	if (mist === null) return mistToSui(null);
	let value: bigint;
	try {
		value =
			typeof mist === 'bigint' ? mist : BigInt(typeof mist === 'number' ? Math.trunc(mist) : mist);
	} catch {
		return String(mist);
	}
	if (decimals === 9) return mistToSui(value);
	// Rescale to 9-decimal MIST so the shared formatter applies uniformly.
	const scaled =
		decimals < 9 ? value * 10n ** BigInt(9 - decimals) : value / 10n ** BigInt(decimals - 9);
	return mistToSui(scaled);
};
