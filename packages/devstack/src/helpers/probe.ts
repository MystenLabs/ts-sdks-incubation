// Shared HTTP-probe helpers. Plugins use these to wait for a child
// process / container's listener to come up, and to gate `getStatus`
// "is this still serving" checks. Each call site has its own
// "what counts as up?" rule (vite dev server returns anything; the
// wallet-server health endpoint must be 2xx; the sui faucet returns
// 405 on GET because it's POST-only); pass an `accept` predicate to
// override the default `res.ok`.

export interface ProbeOptions {
	/** Acceptance predicate over the fetch Response. Default: `res.ok`
	 * (2xx). */
	accept?: (res: Response) => boolean;
}

export interface WaitForReachableOptions extends ProbeOptions {
	/** Polling interval. Default 250ms. */
	intervalMs?: number;
	/** Optional logger called once when the URL becomes reachable. */
	log?: (line: string) => void;
}

/** Single-shot probe: returns true if a GET to `url` resolves with a
 * Response that the `accept` predicate considers up. Network errors and
 * thrown exceptions return false. Never throws. */
export async function probeUrl(url: string, opts: ProbeOptions = {}): Promise<boolean> {
	const accept = opts.accept ?? ((r) => r.ok);
	try {
		const res = await fetch(url, { method: 'GET', redirect: 'manual' });
		return accept(res);
	} catch {
		return false;
	}
}

/** Poll `probeUrl(url)` until it returns true or `timeoutMs` elapses.
 * Throws on timeout with an actionable error pointing at the URL. */
export async function waitForReachable(
	url: string,
	timeoutMs: number,
	opts: WaitForReachableOptions = {},
): Promise<void> {
	const start = Date.now();
	const interval = opts.intervalMs ?? 250;
	while (Date.now() - start < timeoutMs) {
		if (await probeUrl(url, opts)) {
			opts.log?.(`ready at ${url}`);
			return;
		}
		await new Promise((r) => setTimeout(r, interval));
	}
	throw new Error(`waitForReachable: ${url} did not become reachable within ${timeoutMs}ms`);
}
