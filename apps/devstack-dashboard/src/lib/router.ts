// Minimal hash-based router. No dependency, no history API — just
// `location.hash` parsed into `{ name, param }` and a `hashchange` subscription.
//
// Hash shapes: `#/services`, `#/services/sui%230` (param decoded → `sui#0`),
// `#/logs`. Empty hash → the `overview` route.

import { useEffect, useState } from 'react';

export interface Route {
	readonly name: string;
	readonly param?: string;
}

/** Well-known panel names. The router itself stays generic. */
export const ROUTE_NAMES = [
	'overview',
	'services',
	'logs',
	'activity',
	'accounts',
	'faucet',
	'explorer',
	'controls',
	'config',
] as const;

const DEFAULT_ROUTE: Route = { name: 'overview' };

// The `param` carries structured ids (object ids, coin types like
// `0x2::sui::SUI`, explorer sub-routes like `object/0x…`). Percent-encoding the
// whole thing turns every `:` into `%3A` and `/` into `%2F` — ugly and fragile.
// Instead we keep URL path-safe characters literal and escape only genuinely
// unsafe ones. The set kept literal is the URI "pchar" plus `/` (sub-route
// separator) and `:` (coin-type separator): letters, digits, and `: / . - _ ~`.
// `#`, `%`, `?`, space, etc. still round-trip through `encodeURIComponent`.
const PARAM_SAFE = /[^A-Za-z0-9:/.\-_~]/g;

const encodeParam = (param: string): string =>
	param.replace(PARAM_SAFE, (ch) => encodeURIComponent(ch));

export const parseHash = (hash: string): Route => {
	// Strip leading `#` and optional `/`.
	const raw = hash.replace(/^#\/?/, '');
	if (!raw) return DEFAULT_ROUTE;
	const slash = raw.indexOf('/');
	if (slash === -1) return { name: decodeURIComponent(raw) };
	const name = decodeURIComponent(raw.slice(0, slash));
	// The param keeps its own `/`s (explorer sub-routes) literal; only the
	// individually-escaped unsafe chars are decoded back.
	const param = decodeURIComponent(raw.slice(slash + 1));
	return param ? { name, param } : { name };
};

export const routeHref = (name: string, param?: string): string => {
	const base = `#/${encodeURIComponent(name)}`;
	return param ? `${base}/${encodeParam(param)}` : base;
};

export const navigate = (name: string, param?: string): void => {
	const next = routeHref(name, param);
	if (location.hash !== next) location.hash = next;
};

export const useRoute = (): Route => {
	const [route, setRoute] = useState<Route>(() => parseHash(location.hash));
	useEffect(() => {
		const onChange = () => setRoute(parseHash(location.hash));
		window.addEventListener('hashchange', onChange);
		// Re-sync in case the hash changed between initial render and effect.
		onChange();
		return () => window.removeEventListener('hashchange', onChange);
	}, []);
	return route;
};

// --- Explorer sub-routes ----------------------------------------------------
//
// The Explorer panel browses chain entities. Addresses, objects, and packages
// all share the `0x…` shape and are indistinguishable by format, so the sub-view
// kind is carried explicitly in the `explorer` route's `param` as `<kind>/<id>`
// (a clean path form — no over-encoded `%3A`/`%2F`):
//   `#/explorer`                 → home (latest tx + KPIs)
//   `#/explorer/tx/<digest>`     → transaction detail (digests are base58)
//   `#/explorer/object/<0x>`     → object detail
//   `#/explorer/package/<0x>`    → package detail
//   `#/explorer/address/<0x>`    → address detail
// Routes are CONCRETE: each link site navigates to the kind it already knows, and
// search resolves the ambiguous `0x…` id (probes the node) BEFORE navigating, so
// there is no generic "resolving" route. `parseExplorerView` decodes a route's
// `param`; the `goto*` helpers navigate. The id may itself contain `:` (coin
// types) — we split only on the FIRST `/`.

export type ExplorerViewKind = 'home' | 'tx' | 'object' | 'package' | 'address';

export interface ExplorerView {
	readonly kind: ExplorerViewKind;
	/** Target id (digest / object id / package id / address); empty for `home`. */
	readonly id: string;
}

const EXPLORER_HOME: ExplorerView = { kind: 'home', id: '' };

const DETAIL_KINDS: ReadonlyArray<ExplorerViewKind> = ['tx', 'object', 'package', 'address'];

/** Decode an `explorer` route's `param` into a typed sub-view. */
export const parseExplorerView = (param?: string): ExplorerView => {
	if (!param) return EXPLORER_HOME;
	// Split on the FIRST `/` only — the id can contain `/` and `:` (coin types).
	const slash = param.indexOf('/');
	if (slash === -1) return EXPLORER_HOME;
	const kind = param.slice(0, slash);
	const id = param.slice(slash + 1);
	if (!id) return EXPLORER_HOME;
	if ((DETAIL_KINDS as ReadonlyArray<string>).includes(kind))
		return { kind: kind as ExplorerViewKind, id };
	return EXPLORER_HOME;
};

/** Navigate to the Explorer home. */
export const gotoExplorer = (): void => navigate('explorer');
/** Navigate to a transaction detail in the Explorer. */
export const gotoTx = (digest: string): void => navigate('explorer', `tx/${digest}`);
/** Navigate to an object detail in the Explorer. */
export const gotoObject = (id: string): void => navigate('explorer', `object/${id}`);
/** Navigate to a package detail in the Explorer. */
export const gotoPackage = (id: string): void => navigate('explorer', `package/${id}`);
/** Navigate to an address detail in the Explorer. */
export const gotoAddress = (id: string): void => navigate('explorer', `address/${id}`);
