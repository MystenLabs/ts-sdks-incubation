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
 *  `undefined` for traversal attempts or paths that escape `root`. */
const safeResolve = (root: string, pathname: string): string | undefined => {
	const rel = normalize(pathname).replace(/^(\.\.[/\\])+/, '').replace(/^[/\\]+/, '');
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
		// Localhost dev tool: permissive CORS so the Vite app (different
		// origin) and direct browser tooling can call the API.
		cors: { origin: '*', credentials: false },
	});
	const fallbackPage = testPage(graphqlEndpoint);

	const isGraphql = (url: string): boolean =>
		url === graphqlEndpoint ||
		url.startsWith(`${graphqlEndpoint}?`) ||
		url.startsWith(`${graphqlEndpoint}/`);

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
		if (isGraphql(url)) {
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

		const pathname = requestPathname(url);
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
