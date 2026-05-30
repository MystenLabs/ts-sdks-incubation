// Small pure formatting helpers shared across the dashboard. No React, no deps.

/** Truncate a hex id/address to `0x1234…cdef`. */
export const truncateMiddle = (value: string, lead = 6, tail = 4): string => {
	if (!value) return value;
	if (value.length <= lead + tail + 1) return value;
	return `${value.slice(0, lead)}…${value.slice(-tail)}`;
};

const MIST_PER_SUI = 1_000_000_000n;

/** Format a MIST amount (string or bigint) as a human SUI value. */
export const mistToSui = (mist: string | bigint | null | undefined): string => {
	if (mist === null || mist === undefined) return '—';
	let value: bigint;
	try {
		value = typeof mist === 'bigint' ? mist : BigInt(mist);
	} catch {
		return String(mist);
	}
	const whole = value / MIST_PER_SUI;
	const frac = value % MIST_PER_SUI;
	if (frac === 0n) return `${whole.toString()}`;
	// up to 4 significant fractional digits, trimmed
	const fracStr = frac.toString().padStart(9, '0').slice(0, 4).replace(/0+$/, '');
	return fracStr ? `${whole.toString()}.${fracStr}` : whole.toString();
};

/** Group integer-ish strings with thousands separators. */
export const groupDigits = (value: string | number): string => {
	const s = String(value);
	const neg = s.startsWith('-');
	const digits = neg ? s.slice(1) : s;
	const grouped = digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
	return neg ? `-${grouped}` : grouped;
};

/** Compact relative time, e.g. "now", "12s", "3m", "2h". */
export const timeAgo = (at: number, now = Date.now()): string => {
	const ms = Math.max(0, now - at);
	const s = Math.floor(ms / 1000);
	if (s < 2) return 'now';
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m`;
	const h = Math.floor(m / 60);
	if (h < 24) return `${h}h`;
	const d = Math.floor(h / 24);
	return `${d}d`;
};

/** Wall-clock time, e.g. "14:23:05". */
export const clockTime = (at: number): string => new Date(at).toLocaleTimeString();

/** Title-case a kebab/snake token: "shutting-down" -> "Shutting down". */
export const humanize = (token: string): string => {
	const spaced = token.replace(/[-_]+/g, ' ').trim();
	if (!spaced) return token;
	return spaced.charAt(0).toUpperCase() + spaced.slice(1);
};

/** True for strings shaped like a Sui object id / address. */
export const looksLikeId = (value: string): boolean => /^0x[0-9a-fA-F]{1,64}$/.test(value);

/** An endpoint's display host — its `displayUrl` (or `url`) without the scheme. */
export const displayHost = (endpoint: {
	readonly url: string;
	readonly displayUrl: string | null;
}): string => (endpoint.displayUrl ?? endpoint.url).replace(/^https?:\/\//, '');

/** Scale a whole-token amount to a base-unit integer string (amount × 10^decimals)
 *  using BigInt to avoid float error. */
export const toBaseUnits = (amount: number, decimals: number): string =>
	(BigInt(Math.trunc(amount)) * 10n ** BigInt(decimals)).toString();

/** Human byte size (IEC), e.g. "1.4 GB". */
export const formatBytes = (bytes: number): string => {
	if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
	const units = ['B', 'KB', 'MB', 'GB', 'TB'];
	let value = bytes;
	let i = 0;
	while (value >= 1024 && i < units.length - 1) {
		value /= 1024;
		i += 1;
	}
	const fixed = value >= 100 || i === 0 ? Math.round(value).toString() : value.toFixed(1);
	return `${fixed} ${units[i]}`;
};
