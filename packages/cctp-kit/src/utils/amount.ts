// Copyright (c) Mysten Labs, Inc.
// SPDX-License-Identifier: Apache-2.0

import { USDC_DECIMALS } from '../chains/types.js';

/** Parse a user-entered decimal string into USDC base units (6 decimals). */
export function parseUsdc(input: string): bigint {
	const trimmed = input.trim();
	if (!/^\d*(\.\d*)?$/.test(trimmed) || trimmed === '' || trimmed === '.') {
		throw new Error('Invalid amount');
	}
	const [whole = '0', fraction = ''] = trimmed.split('.');
	if (fraction.length > USDC_DECIMALS) {
		throw new Error(`USDC supports at most ${USDC_DECIMALS} decimal places`);
	}
	const padded = fraction.padEnd(USDC_DECIMALS, '0');
	return BigInt(whole || '0') * 10n ** BigInt(USDC_DECIMALS) + BigInt(padded || '0');
}

/** Format base units as a decimal string, trimming trailing zeros. */
export function formatUsdc(units: bigint | string | number, maxFraction = USDC_DECIMALS): string {
	const value = BigInt(units);
	const negative = value < 0n;
	const abs = negative ? -value : value;
	const base = 10n ** BigInt(USDC_DECIMALS);
	const whole = abs / base;
	let fraction = (abs % base).toString().padStart(USDC_DECIMALS, '0').slice(0, maxFraction);
	fraction = fraction.replace(/0+$/, '');
	return `${negative ? '-' : ''}${whole}${fraction ? `.${fraction}` : ''}`;
}

/** Basis points of an amount, rounded up (Circle rounds fees up). */
export function feeFromBps(amount: bigint, bps: number): bigint {
	if (bps <= 0) return 0n;
	const numerator = amount * BigInt(Math.round(bps * 100));
	const denominator = 1_000_000n;
	return (numerator + denominator - 1n) / denominator;
}
