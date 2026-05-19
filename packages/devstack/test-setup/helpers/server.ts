// `connectDeepbookServer(url)` — typed thin wrapper over the
// DeepBook server REST API for L3 docker tests. The Rust server
// binary exposes a small set of read-only endpoints; tests below
// hit `/ticker` and `/trades/<pool>` and decode the JSON
// envelope into a structured shape so assertions don't have to
// re-parse strings.
//
// Endpoint shapes mirror sandbox-side captures
// (`~/code/deepbook-sandbox/sandbox/docker-compose.yml:195-228`);
// the actual on-the-wire schema is whatever the deepbook-v3 Rust
// `deepbook-server` ships in the pinned image, so we keep the
// wrapper minimal and decode best-effort. Tests assert presence
// + numeric coercion of the load-bearing fields.

export interface DeepbookTickerRow {
	readonly lastPrice: number;
	readonly bestBid: number;
	readonly bestAsk: number;
}

export interface DeepbookTradeRow {
	readonly price: number;
	readonly size: number;
	readonly timestamp: number;
}

export interface DeepbookServerClient {
	/** GET `/ticker` — pool-keyed last-price/best-bid/best-ask map. */
	readonly ticker: () => Promise<Record<string, DeepbookTickerRow>>;
	/** GET `/trades/<pool>` — most recent trades for the named pool. */
	readonly trades: (pool: string) => Promise<ReadonlyArray<DeepbookTradeRow>>;
}

const coerceNumber = (v: unknown): number => {
	if (typeof v === 'number') return v;
	if (typeof v === 'string') {
		const n = Number(v);
		return Number.isFinite(n) ? n : 0;
	}
	return 0;
};

/** Construct a thin REST client against the DeepBook server. `url`
 *  is the traefik-routed base, e.g.
 *  `http://deepbook-server.<app>.localhost:9008/`. The trailing slash
 *  is folded into the endpoint paths. */
export const connectDeepbookServer = (url: string): DeepbookServerClient => {
	const base = url.endsWith('/') ? url.slice(0, -1) : url;
	const get = async (path: string): Promise<unknown> => {
		const r = await fetch(`${base}${path}`, { signal: AbortSignal.timeout(10_000) });
		if (!r.ok) {
			throw new Error(`deepbook-server: GET ${path} → ${r.status}`);
		}
		return r.json();
	};
	return {
		ticker: async () => {
			const body = (await get('/ticker')) as Record<string, Record<string, unknown>>;
			const out: Record<string, DeepbookTickerRow> = {};
			for (const [k, row] of Object.entries(body ?? {})) {
				out[k] = {
					lastPrice: coerceNumber(row['last_price'] ?? row['lastPrice']),
					bestBid: coerceNumber(row['best_bid'] ?? row['bestBid']),
					bestAsk: coerceNumber(row['best_ask'] ?? row['bestAsk']),
				};
			}
			return out;
		},
		trades: async (pool: string) => {
			const body = (await get(`/trades/${encodeURIComponent(pool)}`)) as ReadonlyArray<
				Record<string, unknown>
			>;
			const arr = Array.isArray(body) ? body : [];
			return arr.map((row) => ({
				price: coerceNumber(row['price']),
				size: coerceNumber(row['size'] ?? row['base_quantity']),
				timestamp: coerceNumber(row['timestamp'] ?? row['onchain_timestamp']),
			}));
		},
	};
};
