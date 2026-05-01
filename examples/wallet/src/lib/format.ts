export const SUI_DECIMALS = 9;

export function formatCoin(
	raw: bigint | string | number,
	decimals: number,
	fractionDigits = 4,
): string {
	const big = typeof raw === 'bigint' ? raw : BigInt(raw);
	const divisor = 10n ** BigInt(decimals);
	const whole = big / divisor;
	const frac = big % divisor;
	const fracStr = frac.toString().padStart(decimals, '0').slice(0, fractionDigits);
	return fractionDigits > 0 ? `${whole.toString()}.${fracStr}` : whole.toString();
}

export function parseCoinAmount(input: string, decimals: number): bigint {
	const trimmed = input.trim();
	if (!trimmed) return 0n;
	const pattern = new RegExp(`^\\d+(\\.\\d{0,${decimals}})?$`);
	if (!pattern.test(trimmed)) {
		throw new Error(`Enter a non-negative number with up to ${decimals} decimal places`);
	}
	const [whole, frac = ''] = trimmed.split('.');
	const padded = (frac + '0'.repeat(decimals)).slice(0, decimals);
	return BigInt(whole ?? '0') * 10n ** BigInt(decimals) + BigInt(padded || '0');
}

export const formatSui = (raw: bigint | string | number, fractionDigits = 4) =>
	formatCoin(raw, SUI_DECIMALS, fractionDigits);
export const parseSuiAmount = (input: string) => parseCoinAmount(input, SUI_DECIMALS);

// FRICTION: shortAddress + labelFor are duplicated from examples/token-studio/src/lib/coin.ts.
// Move to a shared `@mysten-incubation/ui-utils` (or similar) once a third copy appears.
export function shortAddress(address: string, head = 6, tail = 4): string {
	if (address.length <= head + tail + 2) return address;
	return `${address.slice(0, head + 2)}…${address.slice(-tail)}`;
}

export function labelFor(address: string, accounts: Record<string, string>): string | null {
	for (const [name, addr] of Object.entries(accounts)) {
		if (addr === address) return name;
	}
	return null;
}
