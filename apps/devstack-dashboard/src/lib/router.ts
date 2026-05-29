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

export const parseHash = (hash: string): Route => {
	// Strip leading `#` and optional `/`.
	const raw = hash.replace(/^#\/?/, '');
	if (!raw) return DEFAULT_ROUTE;
	const slash = raw.indexOf('/');
	if (slash === -1) return { name: decodeURIComponent(raw) };
	const name = decodeURIComponent(raw.slice(0, slash));
	const param = decodeURIComponent(raw.slice(slash + 1));
	return param ? { name, param } : { name };
};

export const routeHref = (name: string, param?: string): string => {
	const base = `#/${encodeURIComponent(name)}`;
	return param ? `${base}/${encodeURIComponent(param)}` : base;
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
// The Explorer panel browses chain entities (transactions, objects, packages).
// To stay within the router's single-`param` mechanism, the Explorer sub-view
// is encoded into the `explorer` route's `param` as `<kind>:<id>`:
//   `#/explorer`                 → home (latest tx + KPIs)
//   `#/explorer/tx:<digest>`     → transaction detail
//   `#/explorer/object:<id>`     → object detail
//   `#/explorer/package:<id>`    → package detail
// `parseExplorerView` decodes a route's `param`; the `goto*` helpers navigate.

export type ExplorerViewKind = 'home' | 'tx' | 'object' | 'package';

export interface ExplorerView {
	readonly kind: ExplorerViewKind;
	/** Target id (digest / object id / package id); empty for `home`. */
	readonly id: string;
}

const EXPLORER_HOME: ExplorerView = { kind: 'home', id: '' };

/** Decode an `explorer` route's `param` into a typed sub-view. */
export const parseExplorerView = (param?: string): ExplorerView => {
	if (!param) return EXPLORER_HOME;
	const colon = param.indexOf(':');
	if (colon === -1) return EXPLORER_HOME;
	const kind = param.slice(0, colon);
	const id = param.slice(colon + 1);
	if (!id) return EXPLORER_HOME;
	if (kind === 'tx' || kind === 'object' || kind === 'package') return { kind, id };
	return EXPLORER_HOME;
};

/** Navigate to the Explorer home. */
export const gotoExplorer = (): void => navigate('explorer');
/** Navigate to a transaction detail in the Explorer. */
export const gotoTx = (digest: string): void => navigate('explorer', `tx:${digest}`);
/** Navigate to an object detail in the Explorer. */
export const gotoObject = (id: string): void => navigate('explorer', `object:${id}`);
/** Navigate to a package detail in the Explorer. */
export const gotoPackage = (id: string): void => navigate('explorer', `package:${id}`);
