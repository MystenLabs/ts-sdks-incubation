// Shared HTTP-probe helpers. Plugins use these to wait for a child
// process / container's listener to come up, and to gate `getStatus`
// "is this still serving" checks. Each call site has its own
// "what counts as up?" rule (vite dev server returns anything; the
// wallet-app health endpoint must be 2xx; the sui faucet returns
// 405 on GET because it's POST-only); pass an `accept` predicate to
// override the default `res.ok`.

export interface ProbeOptions {
	/** Acceptance predicate over the fetch Response. Default: `res.ok`
	 * (2xx). */
	accept?: (res: Response) => boolean;
	/** Per-request timeout in ms. A single hung response would otherwise
	 * burn the polling budget on one attempt — without this, a stuck
	 * fetch can sit for ~30s while `waitForReachable` thinks it's
	 * polling. Default 1500ms. Callers with their own outer loop should
	 * keep this strictly smaller than the loop interval. */
	intervalMs?: number;
	/** Extra request headers. Useful when the target performs Host-header
	 * vhost routing (walrus.proxy nginx vhosts by Host: walrus-node-N) and
	 * the URL alone wouldn't carry the right value. */
	headers?: Record<string, string>;
}

export interface WaitForReachableOptions extends ProbeOptions {
	/** Polling interval. Default 250ms. */
	intervalMs?: number;
	/** Optional logger called once when the URL becomes reachable. */
	log?: (line: string) => void;
}

/** Single-shot probe: returns true if a GET to `url` resolves with a
 * Response that the `accept` predicate considers up. Network errors,
 * timeouts (`AbortSignal.timeout`), and thrown exceptions return false.
 * Never throws. */
export async function probeUrl(url: string, opts: ProbeOptions = {}): Promise<boolean> {
	return (await probeUrlDetailed(url, opts)).ok;
}

/** Like `probeUrl` but returns the outcome detail (HTTP status, fetch
 * error first line, or `'timeout'`) so callers can surface why a probe
 * failed in the timeout error. Never throws. */
async function probeUrlDetailed(
	url: string,
	opts: ProbeOptions = {},
): Promise<{ ok: true } | { ok: false; outcome: string }> {
	const accept = opts.accept ?? ((r) => r.ok);
	const timeoutMs = opts.intervalMs ?? 1500;
	try {
		const res = await fetch(url, {
			method: 'GET',
			redirect: 'manual',
			signal: AbortSignal.timeout(timeoutMs),
			...(opts.headers !== undefined ? { headers: opts.headers } : {}),
		});
		if (accept(res)) return { ok: true };
		return { ok: false, outcome: `HTTP ${res.status}` };
	} catch (err) {
		// `AbortSignal.timeout` rejects with a TimeoutError DOMException.
		if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
			return { ok: false, outcome: 'timeout' };
		}
		const msg = err instanceof Error ? err.message : String(err);
		const firstLine = msg.split('\n')[0] ?? msg;
		return { ok: false, outcome: `fetch failed: ${firstLine}` };
	}
}

/** Poll `probeUrl(url)` until it returns true or `timeoutMs` elapses.
 * Throws on timeout with an actionable error pointing at the URL,
 * including the most-recent probe outcome (HTTP status, fetch error,
 * or `timeout`) so operators see why polling never completed. */
export async function waitForReachable(
	url: string,
	timeoutMs: number,
	opts: WaitForReachableOptions = {},
): Promise<void> {
	const start = Date.now();
	const interval = opts.intervalMs ?? 250;
	// Per-request timeout: cap each fetch so a single hung response
	// doesn't blow the polling budget. Keep below the loop interval so
	// the loop's cadence dominates; clamp to a 1500ms ceiling so very
	// long polling intervals (e.g. 30s) still fail their inner fetch
	// quickly. Floor at 200ms to avoid spurious aborts on slow boxes.
	const perRequestMs = Math.max(200, Math.min(Math.floor(interval * 0.9), 1500));
	let lastOutcome: string | undefined;
	while (Date.now() - start < timeoutMs) {
		const result = await probeUrlDetailed(url, { ...opts, intervalMs: perRequestMs });
		if (result.ok) {
			opts.log?.(`ready at ${url}`);
			return;
		}
		lastOutcome = result.outcome;
		await new Promise((r) => setTimeout(r, interval));
	}
	throw new Error(
		`waitForReachable: ${url} did not become reachable within ${timeoutMs}ms ` +
			`(last: ${lastOutcome ?? 'no probes attempted'})`,
	);
}
