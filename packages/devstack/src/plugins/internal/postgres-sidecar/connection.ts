// Internal Postgres sidecar connection-string builders.
//
// Distilled-doc § Postgres-specific concerns: two URL shapes must exit
// the sidecar —
//
//   1. CREDENTIALED form (`postgres://<user>:<pw>@<host>:<port>`) for
//      in-process / in-stack dialers that need to issue real queries.
//   2. PLAIN form (`postgres://<host>:<port>`) for the on-disk manifest
//      and for any non-secret display. NEVER carries the password.
//
// Both shapes can be extended with a database name segment via
// `withDatabase`. The plain form's existence is the structural cure
// for the "credentialed URL leaks via console.log" foot-gun called
// out in the distilled doc's learnings.

/** Components of a postgres connection. The plugin keeps these in
 *  one record so URL construction is a single function call. */
export interface PostgresConnectionParts {
	readonly user: string;
	readonly password: string;
	readonly host: string;
	readonly port: number;
}

/** Build the credentialed URL.
 *
 *  Caller convention: this URL MUST NOT be logged or persisted to
 *  disk. The substrate's observability redactor strips it on best-
 *  effort; the structural cure is to use `plainUrl` everywhere the
 *  password isn't needed. */
export const credentialedUrl = (parts: PostgresConnectionParts): string => {
	const { user, password, host, port } = parts;
	return `postgres://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${host}:${port}`;
};

/** Build the no-credentials URL. Manifest-safe by construction. */
export const plainUrl = (host: string, port: number): string => `postgres://${host}:${port}`;

/** Compose a database segment onto a base URL. */
export const withDatabase = (baseUrl: string, db: string): string =>
	`${baseUrl}/${encodeURIComponent(db)}`;
