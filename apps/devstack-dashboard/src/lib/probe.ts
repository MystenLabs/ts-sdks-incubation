// Shared browser-direct daemon-reachability probe.
//
// Both the Seal and Walrus panels probe a backend daemon *directly* from the
// browser (the control plane does not relay it) and degrade gracefully when the
// cross-origin fetch can't read a status. They previously each carried a
// near-identical copy of this 3-state probe — and it had already drifted once.
// This module is the single source of truth so a third drift can't happen.
//
// Three distinct probe outcomes drive the dot + banner:
//   - `up`          — a candidate answered a *readable* 2xx. Green, no banner.
//   - `down`        — a candidate answered a *readable* non-2xx status (e.g.
//                     502/503 from a proxy in front of a dead daemon, or a 404
//                     from a wrong URL). A response WAS received and the browser
//                     could read it, so this is a genuine outage, not an
//                     ambiguity. Red, "requests will fail" banner.
//   - `unreachable` — no readable response at all: the cross-origin `fetch`
//                     threw (network/CORS) and even a `no-cors` ping couldn't
//                     prove the socket alive, OR the socket answered but only as
//                     an opaque (CORS-hidden) response we can't read a status
//                     from. Genuinely ambiguous — the in-process daemon may
//                     still serve — so it stays a soft yellow.
//
// For multiple candidates, a *readable non-2xx on ANY candidate* wins `down`
// over the `unreachable` fallback (we remember it but keep trying later
// candidates, which might return 2xx; if none does, the remembered `down`
// wins). With a single candidate this collapses to the simple single-URL case.
//
// This module is framework-light: no React beyond the `ProbeState` type. Panels
// keep their own JSX and import the state machine + token/label/banner content.

import type { BannerTone } from '../ui/Banner.tsx';

/** Health states for a browser-direct daemon probe.
 *  - `probing`     — the probe is in flight (yellow).
 *  - `up`          — a candidate answered a *readable* 2xx (green).
 *  - `down`        — a candidate answered a *readable* non-2xx status; the
 *                    daemon is genuinely down / misrouted (red).
 *  - `unreachable` — no readable response (fetch threw, or an opaque CORS-hidden
 *                    response): genuinely ambiguous, may still work in-process
 *                    (yellow). */
export type ProbeState = 'probing' | 'up' | 'down' | 'unreachable';

export interface ProbeResult {
	readonly state: ProbeState;
	/** Short human note (HTTP status / failure reason) for the tooltip/body. */
	readonly detail: string;
}

/**
 * Probe a daemon directly from the browser across one or more candidate URLs.
 *
 * The caller supplies fully-formed candidate URLs (Seal: a single `/health`
 * route; Walrus: `[${root}/v1/api, root]`). Each candidate is tried in order:
 *
 *   - `up`          — a *readable* 2xx from a candidate. Returned immediately.
 *   - `down`        — a *readable* non-2xx (404/502/503…) from a candidate. A
 *                     response WAS received and the browser could read its
 *                     status; a healthy daemon answers 2xx, so this is a wrong
 *                     URL or — more often — a proxy/load-balancer in front of a
 *                     dead daemon. A genuine outage we must surface in red, not
 *                     soften. Remembered and kept (over later candidates and the
 *                     `unreachable` fallback) unless a later candidate is `up`.
 *   - `unreachable` — no readable status at all from any candidate. Either the
 *                     cross-origin `fetch` *threw* (network down / CORS preflight
 *                     rejected) and even a `no-cors` ping couldn't confirm the
 *                     socket, OR the socket answered but only as an *opaque*
 *                     (CORS-hidden) response we can't read a status from. Both
 *                     are genuinely ambiguous — the in-process daemon may still
 *                     serve — so they stay a soft yellow with the "may be
 *                     CORS/network" copy.
 *
 * @param candidates One or more fully-formed URLs to probe, in priority order.
 *                   (A single-URL probe is just an array of length 1.)
 */
export const probeDaemon = async (candidates: ReadonlyArray<string>): Promise<ProbeResult> => {
	let lastDetail = 'no response';
	// A readable non-2xx is a genuine daemon-down signal. We remember it but keep
	// trying the next candidate (which might return 2xx); if none does, this wins
	// over the ambiguous `unreachable` fallback.
	let downDetail: string | null = null;
	for (const url of candidates) {
		try {
			const res = await fetch(url, { method: 'GET', mode: 'cors' });
			// `type: 'opaque'` means a no-cors response slipped through with a hidden
			// status (res.ok forced false, res.status forced 0) — we can't read it, so
			// treat it as the ambiguous reachable-but-unreadable case, not `down`.
			if (res.type === 'opaque') {
				lastDetail = `reachable (opaque) · ${url}`;
				continue;
			}
			if (res.ok) return { state: 'up', detail: `HTTP ${res.status} · ${url}` };
			// Readable non-2xx — a response came back and we can read its status. A
			// healthy daemon returns 2xx, so this is a down/misrouted daemon.
			downDetail = `HTTP ${res.status} on ${url} (expected 2xx)`;
			lastDetail = downDetail;
		} catch (err) {
			// The CORS-mode fetch threw (network/CORS). A `no-cors` ping that *resolves*
			// proves a socket is alive but yields an opaque, unreadable response — we
			// still can't distinguish a healthy daemon from a down one behind a proxy,
			// so it remains the ambiguous `unreachable` case, not green.
			try {
				await fetch(url, { method: 'GET', mode: 'no-cors' });
				lastDetail = `reachable (opaque) · ${url}`;
			} catch {
				lastDetail = err instanceof Error ? err.message : String(err);
			}
		}
	}
	// A readable non-2xx anywhere is a genuine outage (red); otherwise no readable
	// response at all, which is the ambiguous CORS/network case (soft yellow).
	if (downDetail !== null) return { state: 'down', detail: downDetail };
	return { state: 'unreachable', detail: lastDetail };
};

/** Convenience: strip trailing slashes from a base URL before composing routes. */
export const trimTrailingSlash = (baseUrl: string): string => baseUrl.replace(/\/+$/, '');

/** Dot / text color token per probe state (up=green, down=red, else yellow). */
export const PROBE_TOKEN: Record<ProbeState, 'green' | 'yellow' | 'red'> = {
	probing: 'yellow',
	up: 'green',
	down: 'red',
	unreachable: 'yellow',
};

/**
 * Status label per probe state. The `up` label differs per panel (Seal renders
 * `up`, Walrus renders `reachable`), so it's parameterized; the rest are shared.
 *
 * @param upLabel Label to render for the `up` state. Defaults to `'up'` (Seal);
 *                Walrus passes `'reachable'`.
 */
export const probeLabel = (upLabel = 'up'): Record<ProbeState, string> => ({
	probing: 'probing',
	up: upLabel,
	down: 'down',
	unreachable: 'unreachable',
});

export interface BannerCopy {
	/**
	 * Exact title for the `down` banner, e.g. `Key-server is down` /
	 * `Walrus aggregator is down`. Supplied verbatim (the "Walrus" qualifier and
	 * casing differ per panel), so each panel reproduces its current title.
	 */
	readonly downTitle: string;
	/**
	 * Exact title for the `unreachable` banner, e.g.
	 * `Key-server unreachable from the browser` /
	 * `Aggregator unreachable from the browser`.
	 */
	readonly unreachableTitle: string;
	/**
	 * Possessive subject + endpoint phrase inserted into the body, e.g.
	 * `key-server's /health route` / `aggregator's HTTP API`. Supplied verbatim
	 * because the route wording differs per panel.
	 */
	readonly endpointPhrase: string;
	/**
	 * Noun used in the `unreachable` "…rather than the X being down…" clause —
	 * Seal renders `server`, Walrus renders `daemon`. Supplied verbatim.
	 */
	readonly unreachableSubject: string;
	/**
	 * What fails when it's down, e.g. `Encryption` / `Storage`. Rendered
	 * capitalized in the `down` body and lowercased in the `unreachable` body,
	 * matching today's copy.
	 */
	readonly downConsequence: string;
}

export interface ProbeBanner {
	readonly tone: BannerTone;
	readonly title: string;
	readonly body: string;
}

/**
 * Banner content for a probe state, or `null` when no banner should render
 * (`up` / `probing`). Two banner-worthy states:
 *
 *   - `down`        — a readable non-2xx: a genuine outage, surfaced in red
 *                     (`danger`) with the hard "<consequence> requests will
 *                     fail" copy.
 *   - `unreachable` — no readable response: the ambiguous CORS/network case,
 *                     surfaced in soft yellow (`warn`) with the "may still work
 *                     in-process" copy.
 *
 * The sentence structure is shared; each panel supplies its own verbatim
 * `downTitle` / `unreachableTitle` / `endpointPhrase` / `unreachableSubject` /
 * `downConsequence` so it reproduces its current copy exactly (the "Walrus"
 * title qualifier, the `/health route` vs `HTTP API` phrasing, and the
 * `server` vs `daemon` noun all differ per panel). The returned `body` does NOT
 * include the trailing ` (detail)` — panels append `probe.detail` themselves,
 * exactly as they do today.
 */
export const probeBanner = (state: ProbeState, copy: BannerCopy): ProbeBanner | null => {
	const { downTitle, unreachableTitle, endpointPhrase, unreachableSubject, downConsequence } = copy;
	if (state === 'down') {
		return {
			tone: 'danger',
			title: downTitle,
			body:
				`The ${endpointPhrase} returned a non-2xx status — the daemon is down (or a proxy is ` +
				`in front of a dead daemon). ${downConsequence} requests will fail until it recovers.`,
		};
	}
	if (state === 'unreachable') {
		return {
			tone: 'warn',
			title: unreachableTitle,
			body:
				`Couldn't read a response from the ${endpointPhrase}. This may be a CORS or network ` +
				`issue from the browser rather than the ${unreachableSubject} being down — ` +
				`${downConsequence.toLowerCase()} requests may still work in-process.`,
		};
	}
	return null;
};
