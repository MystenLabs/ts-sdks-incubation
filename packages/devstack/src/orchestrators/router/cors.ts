// CORS middleware factory.
//
// Architecture distilled-doc §"Shared CORS middleware":
//   - ONE shared permissive CORS middleware. Backends opt in by setting
//     `Routable.cors: true`; the orchestrator wires the middleware
//     reference into the dispatch file. Backends never write CORS
//     headers themselves.
//
//   - The middleware file is rewritten on each router boot, BEFORE any
//     per-backend file references it. It sorts lexicographically
//     ahead of per-backend filenames (we prefix with `00-`) so the
//     file-provider watcher loads it first.
//
//   - Permissive (`*` allow-origin, very long max-age) — fine for the
//     dev-loop, footgun if copied elsewhere; documented at the call
//     site, not in production-ready posture.

// The Traefik middleware name baked into the file-provider config. We
// use a constant so the same string flows through `file-provider.ts`'s
// route renderer.
export const CORS_MIDDLEWARE_NAME = 'devstack-cors';

/** Filename for the shared-middlewares file. The `00-` prefix forces
 *  alphabetic-sort ordering ahead of per-backend dispatch files. */
export const CORS_MIDDLEWARE_FILENAME = '00-shared-middlewares.yml';

/** Render the permissive shared-CORS middleware as a Traefik
 *  file-provider YAML body. Backends that set `cors: true` reference
 *  this middleware by name (`devstack-cors`) from their per-backend
 *  routers section. */
export const renderCorsMiddlewareYaml = (): string => {
	// The YAML body below is hand-rolled (no yaml lib dep) because:
	//   - it is a static, fully-controlled string,
	//   - the values are constants known at compile time,
	//   - we explicitly want byte-identical output cycle-to-cycle so
	//     the file-provider watcher doesn't wake on no-op rewrites.
	return [
		`# Devstack shared CORS middleware. Permissive — dev-only.`,
		`# Architecture distilled-doc §"Shared CORS middleware".`,
		`http:`,
		`  middlewares:`,
		`    ${CORS_MIDDLEWARE_NAME}:`,
		`      headers:`,
		`        accessControlAllowOriginList: ["*"]`,
		`        accessControlAllowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS", "PATCH", "HEAD"]`,
		`        accessControlAllowHeaders: ["*"]`,
		`        accessControlExposeHeaders: ["*"]`,
		`        accessControlAllowCredentials: true`,
		`        accessControlMaxAge: 86400`,
		`        addVaryHeader: true`,
		``, // trailing newline; Traefik tolerates either way
	].join('\n');
};
