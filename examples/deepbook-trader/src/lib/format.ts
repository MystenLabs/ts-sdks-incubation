export function shortId(id: string, lead = 10, tail = 6): string {
	if (id.length <= lead + tail + 3) return id;
	return `${id.slice(0, lead)}...${id.slice(-tail)}`;
}

export function formatNumber(value: number, digits = 4): string {
	if (!Number.isFinite(value)) return 'n/a';
	return new Intl.NumberFormat('en-US', {
		maximumFractionDigits: digits,
		minimumFractionDigits: value >= 1 ? 2 : 0,
	}).format(value);
}

export function decimalsFromScalar(scalar: number): number {
	if (!Number.isSafeInteger(scalar) || scalar <= 0) {
		throw new Error(`Invalid coin scalar: ${scalar}`);
	}
	const decimals = Math.log10(scalar);
	if (!Number.isInteger(decimals)) {
		throw new Error(`Coin scalar is not a power of 10: ${scalar}`);
	}
	return decimals;
}

export function formatCoinAmount(
	raw: bigint | string | number,
	scalar: number,
	fractionDigits = 4,
): string {
	const decimals = decimalsFromScalar(scalar);
	const big = typeof raw === 'bigint' ? raw : BigInt(raw);
	const divisor = BigInt(scalar);
	const whole = big / divisor;
	const fraction = big % divisor;
	const fractionText = fraction.toString().padStart(decimals, '0').slice(0, fractionDigits);
	return fractionDigits > 0 ? `${whole.toString()}.${fractionText}` : whole.toString();
}

export function parseCoinAmount(input: string, scalar: number): bigint {
	const decimals = decimalsFromScalar(scalar);
	const trimmed = input.trim();
	if (trimmed.length === 0) return 0n;
	const pattern = new RegExp(`^\\d+(\\.\\d{0,${decimals}})?$`);
	if (!pattern.test(trimmed)) {
		throw new Error(`Enter a non-negative amount with up to ${decimals} decimal places`);
	}
	const [whole = '0', fraction = ''] = trimmed.split('.');
	const paddedFraction = (fraction + '0'.repeat(decimals)).slice(0, decimals);
	return BigInt(whole) * BigInt(scalar) + BigInt(paddedFraction || '0');
}

export function formatPercent(value: number): string {
	return `${formatNumber(value * 100, 4)}%`;
}

export function formatAge(seconds: number): string {
	if (!Number.isFinite(seconds) || seconds < 0) return 'n/a';
	if (seconds < 60) return `${Math.round(seconds)}s`;
	if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
	return `${Math.round(seconds / 3600)}h`;
}
