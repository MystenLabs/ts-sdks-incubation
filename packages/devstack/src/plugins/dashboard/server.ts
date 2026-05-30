// Dashboard HTTP listener.
//
// graphql-yoga hosts the Pothos schema at `/graphql` (with GraphiQL for
// manual testing and SSE for subscriptions). Every other path serves the
// built React SPA bundled with this package under `dashboard-ui/` (produced
// by `pnpm build`'s `build:dashboard-ui` step and shipped via the package
// `files` array). The listener is handed to `listenScopedHttpServer`, which
// owns bind + graceful close.
//
// The SPA is served as static files with a client-side-routing fallback to
// `index.html`. When the UI has not been built (the bundled dir is absent),
// the listener logs a warning once and falls back to the inline test page so
// `/graphql` and manual API checks keep working.

import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createYoga } from 'graphql-yoga';
import { dashboardSchema, type DashboardContext } from './schema.ts';
import type { HttpRequestListener } from '../../substrate/runtime/scoped-http-server.ts';

export interface DashboardListenerOptions {
	/** Per-request control-plane context (the `state` ref + `publishCommand`).
	 *  The dashboard is single-tenant, so this is constant for the server's
	 *  lifetime and handed to yoga as a static `context` factory. */
	readonly context: DashboardContext;
	/** GraphQL path. Defaults to `/graphql`. */
	readonly graphqlEndpoint?: string;
	/** Override the bundled UI assets dir (mainly for tests). Defaults to the
	 *  package's `dashboard-ui/` directory resolved from this module. */
	readonly assetsDir?: string;
}

// The built SPA is copied into `<package root>/dashboard-ui/`. This module
// compiles to `<root>/dist/plugins/dashboard/server.mjs`; the source lives at
// `<root>/src/plugins/dashboard/server.ts`. Both are three levels below the
// package root, so the same relative path resolves the bundled dir whether
// running from `dist/` (installed dependency or repo build) or `src/`
// (`--experimental-strip-types`).
const DASHBOARD_UI_DIR = fileURLToPath(new URL('../../../dashboard-ui', import.meta.url));

const CONTENT_TYPES: Record<string, string> = {
	'.html': 'text/html; charset=utf-8',
	'.js': 'text/javascript; charset=utf-8',
	'.mjs': 'text/javascript; charset=utf-8',
	'.css': 'text/css; charset=utf-8',
	'.json': 'application/json; charset=utf-8',
	'.map': 'application/json; charset=utf-8',
	'.svg': 'image/svg+xml',
	'.png': 'image/png',
	'.jpg': 'image/jpeg',
	'.jpeg': 'image/jpeg',
	'.gif': 'image/gif',
	'.webp': 'image/webp',
	'.ico': 'image/x-icon',
	'.woff': 'font/woff',
	'.woff2': 'font/woff2',
	'.ttf': 'font/ttf',
	'.txt': 'text/plain; charset=utf-8',
	'.wasm': 'application/wasm',
};

const contentTypeFor = (path: string): string => {
	const dot = path.lastIndexOf('.');
	const ext = dot === -1 ? '' : path.slice(dot).toLowerCase();
	return CONTENT_TYPES[ext] ?? 'application/octet-stream';
};

const testPage = (graphqlEndpoint: string): string => `<!doctype html>
<html lang="en">
<head><meta charset="utf-8" /><title>devstack dashboard — API test</title>
<style>body{font:14px/1.5 ui-monospace,monospace;background:#05080f;color:#e6eefb;margin:0;padding:24px}
button{font:inherit;background:#1b2740;color:#e6eefb;border:1px solid #2c3c5e;border-radius:6px;padding:6px 12px;cursor:pointer}
pre{background:#0b1322;border:1px solid #1b2740;border-radius:8px;padding:16px;overflow:auto;max-height:70vh}
a{color:#69b7ff}</style></head>
<body>
<h1>devstack dashboard — API test</h1>
<p>The bundled UI was not found (run <code>pnpm build</code> to bundle it). Falling back to the API test page.</p>
<p>GraphiQL: <a href="${graphqlEndpoint}">${graphqlEndpoint}</a></p>
<p><button id="load">query { state }</button> <button id="restart">mutation { restart }</button></p>
<pre id="out">…</pre>
<script type="module">
const ep = ${JSON.stringify(graphqlEndpoint)};
const out = document.getElementById('out');
async function gql(query){
  const r = await fetch(ep,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({query})});
  return r.json();
}
document.getElementById('load').onclick = async () => {
  out.textContent = JSON.stringify(await gql('{ ping state { cycle { id phase } summary { total ready failed health } services { key status } } }'), null, 2);
};
document.getElementById('restart').onclick = async () => {
  out.textContent = JSON.stringify(await gql('mutation { restart { ok command } }'), null, 2);
};
</script>
</body></html>`;

/** True when `origin` is a loopback/localhost origin (any scheme, any port):
 *  hostname is exactly `localhost`, `127.0.0.1`, `[::1]`, or ends with
 *  `.localhost`. Used to gate CORS — see `loopbackCorsOptions`. */
const isLoopbackOrigin = (origin: string): boolean => {
	let host: string;
	try {
		// `URL.hostname` normalizes IPv6 (`[::1]` → `::1`) and strips the port.
		host = new URL(origin).hostname.toLowerCase();
	} catch {
		return false;
	}
	return (
		host === 'localhost' || host === '127.0.0.1' || host === '::1' || host.endsWith('.localhost')
	);
};

/** CORS policy for the control plane.
 *
 *  The GraphQL schema exposes DESTRUCTIVE mutations (wipe/prune/shutdown/
 *  restart/restoreSnapshot/deleteSnapshot/mint). Since JSON POSTs are
 *  preflighted, a correct CORS policy is a real defense: it stops any
 *  internet site the user happens to be visiting from driving a cross-origin
 *  request against the loopback dashboard.
 *
 *  We reflect the request `Origin` back ONLY when it is a loopback/localhost
 *  origin — that keeps the same-origin bundled SPA AND the Vite dev origin
 *  (`*.localhost` / `localhost:<port>`) working, while denying every other
 *  origin (no `Access-Control-Allow-Origin` header → the browser blocks the
 *  cross-origin read/write). `credentials` stays `false`. */
const loopbackCorsOptions = (
	request: Request,
): { origin: string[]; credentials: boolean } | false => {
	const origin = request.headers.get('origin');
	// No Origin header (same-origin / non-CORS request) → no CORS headers
	// needed. A non-loopback Origin is denied the same way.
	if (origin === null || !isLoopbackOrigin(origin)) return false;
	// Reflect this exact origin (single-element array → echoed verbatim).
	return { origin: [origin], credentials: false };
};

/** Strip query/hash and decode a request path into a relative file path. */
const requestPathname = (url: string): string => {
	const noQuery = url.split(/[?#]/, 1)[0] ?? '/';
	try {
		return decodeURIComponent(noQuery);
	} catch {
		return noQuery;
	}
};

/** Resolve a request pathname to an absolute file inside `root`, returning
 *  `undefined` for traversal attempts or paths that escape `root`.
 *
 *  Traversal is REJECTED, not re-rooted: if the normalized path still bears
 *  a `..` segment we bail rather than stripping it and serving a different
 *  file than was requested. The `startsWith(root)` guard then closes any
 *  residual escape (e.g. a sibling dir sharing a prefix). */
const safeResolve = (root: string, pathname: string): string | undefined => {
	const normalized = normalize(pathname);
	// A surviving `..` segment means the request tried to climb out of `root`;
	// reject rather than re-root. Cover both separators and bare/trailing forms.
	if (
		normalized === '..' ||
		normalized.startsWith(`..${sep}`) ||
		normalized.startsWith('../') ||
		normalized.includes(`${sep}..${sep}`) ||
		normalized.includes('/../') ||
		normalized.endsWith(`${sep}..`) ||
		normalized.endsWith('/..')
	) {
		return undefined;
	}
	const rel = normalized.replace(/^[/\\]+/, '');
	const abs = resolve(root, rel);
	const rootWithSep = root.endsWith(sep) ? root : root + sep;
	if (abs !== root && !abs.startsWith(rootWithSep)) return undefined;
	return abs;
};

/** Build a Node request listener routing `/graphql` to yoga and everything
 *  else to the bundled SPA (with an index.html fallback for client routing).
 *  Falls back to the inline API test page when the UI bundle is absent. */
export const makeDashboardListener = (opts: DashboardListenerOptions): HttpRequestListener => {
	const graphqlEndpoint = opts.graphqlEndpoint ?? '/graphql';
	const assetsDir = opts.assetsDir ?? DASHBOARD_UI_DIR;
	const indexHtmlPath = join(assetsDir, 'index.html');
	const uiAvailable = existsSync(indexHtmlPath);

	if (!uiAvailable) {
		// eslint-disable-next-line no-console
		console.warn(
			`[devstack:dashboard] bundled UI not found at ${assetsDir}; serving the API test page only. Run \`pnpm build\` (or \`pnpm --filter @mysten-incubation/devstack build:dashboard-ui\`) to bundle the dashboard.`,
		);
	}

	const yoga = createYoga({
		schema: dashboardSchema,
		context: () => opts.context,
		graphqlEndpoint,
		graphiql: true,
		landingPage: false,
		// Loopback-origin allowlist (see `loopbackCorsOptions`): reflect only
		// localhost/127.0.0.1/[::1]/*.localhost origins so the bundled SPA and
		// the Vite dev origin work while arbitrary internet sites are denied
		// cross-origin access to the destructive control-plane mutations.
		cors: loopbackCorsOptions,
	});
	const fallbackPage = testPage(graphqlEndpoint);

	// Reserve `/graphql` by DECODED pathname so encoded variants
	// (`/graphql%2F…`, `/%67raphql`) route to yoga instead of leaking into the
	// static/SPA path. `pathname` is already query/hash-stripped + decoded.
	const isGraphql = (pathname: string): boolean =>
		pathname === graphqlEndpoint || pathname.startsWith(`${graphqlEndpoint}/`);

	const sendFile = (res: Parameters<HttpRequestListener>[1], absPath: string): boolean => {
		try {
			if (!statSync(absPath).isFile()) return false;
			const body = readFileSync(absPath);
			res.statusCode = 200;
			res.setHeader('content-type', contentTypeFor(absPath));
			res.end(body);
			return true;
		} catch {
			return false;
		}
	};

	return (req, res) => {
		const url = req.url ?? '/';
		const pathname = requestPathname(url);
		if (isGraphql(pathname)) {
			void yoga(req, res);
			return;
		}

		// No bundled UI: keep the API test page as an honest fallback.
		if (!uiAvailable) {
			res.statusCode = 200;
			res.setHeader('content-type', 'text/html; charset=utf-8');
			res.end(fallbackPage);
			return;
		}

		const abs = pathname === '/' ? undefined : safeResolve(assetsDir, pathname);

		// Serve a real static asset when one matches the request path.
		if (abs !== undefined && sendFile(res, abs)) return;

		// SPA fallback: any other path (client-side route) gets index.html so
		// the React router can take over.
		if (sendFile(res, indexHtmlPath)) return;

		res.statusCode = 404;
		res.setHeader('content-type', 'text/plain; charset=utf-8');
		res.end('not found');
	};
};
