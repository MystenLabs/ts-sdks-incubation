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
