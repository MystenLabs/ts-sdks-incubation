// Pure STUDIO amount helpers — no chain, no codegen, no @generated.
// Unit-tested in `amount.test.ts` (runs under `pnpm test`, boots nothing).
// Re-exported from `coin.ts` so UI/components keep a single import site.

export const COIN_DECIMALS = 6;

/** Parse a human STUDIO amount (up to 6 decimals) into raw u64 units.
 *  Empty/whitespace → 0n; throws on negative/non-numeric/over-precise input. */
export function parseStudioAmount(input: string): bigint {
	const trimmed = input.trim();
	if (!trimmed) return 0n;
	if (!/^\d+(\.\d{0,6})?$/.test(trimmed)) {
		throw new Error('Enter a non-negative number with up to 6 decimal places');
	}
	const [whole, frac = ''] = trimmed.split('.');
	const padded = (frac + '0'.repeat(COIN_DECIMALS)).slice(0, COIN_DECIMALS);
	return BigInt(whole ?? '0') * 10n ** BigInt(COIN_DECIMALS) + BigInt(padded || '0');
}

/** Format raw u64 STUDIO units as a decimal string, truncating (not
 *  rounding) to `fractionDigits` places. */
export function formatStudio(raw: bigint | string | number, fractionDigits = 2): string {
	const big = typeof raw === 'bigint' ? raw : BigInt(raw);
	const divisor = 10n ** BigInt(COIN_DECIMALS);
	const whole = big / divisor;
	const frac = big % divisor;
	const fracStr = frac.toString().padStart(COIN_DECIMALS, '0').slice(0, fractionDigits);
	return `${whole.toString()}.${fracStr}`;
}

/** Abbreviate a long 0x address as `0x123456…cdef`. */
export function shortAddress(address: string, head = 6, tail = 4): string {
	if (address.length <= head + tail + 2) return address;
	return `${address.slice(0, head + 2)}…${address.slice(-tail)}`;
}
