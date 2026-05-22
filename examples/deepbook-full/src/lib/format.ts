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

export function formatPercent(value: number): string {
	return `${formatNumber(value * 100, 4)}%`;
}

export function formatAge(seconds: number): string {
	if (!Number.isFinite(seconds) || seconds < 0) return 'n/a';
	if (seconds < 60) return `${Math.round(seconds)}s`;
	if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
	return `${Math.round(seconds / 3600)}h`;
}
