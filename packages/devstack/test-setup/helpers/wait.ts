// Polling primitives for L3 docker tests — `waitForPostgresQuery`
// re-runs a SQL query until a predicate is satisfied (or the budget
// expires); `waitForEndpoint` polls a URL until it returns 2xx
// (typically for service ready probes).

import type { PgClient } from './pg.js';

export interface WaitOptions {
	/** Total budget in ms. Default 60_000. */
	readonly timeoutMs?: number;
	/** Polling interval in ms. Default 1_000. */
	readonly intervalMs?: number;
}

/**
 * Poll a Postgres query until the predicate returns `true`. Throws if
 * the budget elapses without the predicate matching.
 */
export const waitForPostgresQuery = async <T>(
	client: PgClient,
	sql: string,
	predicate: (rows: ReadonlyArray<T>) => boolean,
	opts: WaitOptions = {},
): Promise<void> => {
	const timeoutMs = opts.timeoutMs ?? 60_000;
	const intervalMs = opts.intervalMs ?? 1_000;
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const result = await client.query<T>(sql);
		if (predicate(result.rows)) return;
		await new Promise((resolve) => setTimeout(resolve, intervalMs));
	}
	throw new Error(
		`waitForPostgresQuery: predicate did not match within ${timeoutMs}ms (sql=${sql})`,
	);
};

/**
 * Poll an HTTP endpoint until it returns 2xx. Throws on timeout.
 */
export const waitForEndpoint = async (url: string, opts: WaitOptions = {}): Promise<void> => {
	const timeoutMs = opts.timeoutMs ?? 60_000;
	const intervalMs = opts.intervalMs ?? 1_000;
	const deadline = Date.now() + timeoutMs;
	let lastError: unknown;
	while (Date.now() < deadline) {
		try {
			const r = await fetch(url, { signal: AbortSignal.timeout(5_000) });
			if (r.ok) return;
		} catch (err) {
			lastError = err;
		}
		await new Promise((resolve) => setTimeout(resolve, intervalMs));
	}
	throw new Error(
		`waitForEndpoint: ${url} did not return 2xx within ${timeoutMs}ms (lastError=${String(lastError)})`,
	);
};
