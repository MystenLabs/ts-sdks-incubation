// Postgres connection-string builders + the public typed shape used
// by codegen and consumers.
//
// Distilled-doc § Postgres-specific concerns: two URL shapes must exit
// the plugin —
//
//   1. CREDENTIALED form (`postgres://<user>:<pw>@<host>:<port>`) for
//      in-process / in-stack dialers that need to issue real queries.
//   2. PLAIN form (`postgres://<host>:<port>`) for the on-disk manifest
//      and for the flat-endpoint registry. NEVER carries the password.
//
// Both shapes can be extended with a database name segment via
// `withDatabase`. The plain form's existence is the structural cure
// for the "credentialed URL leaks via console.log" foot-gun called
// out in the distilled doc's learnings — the manifest projection
// refuses anything but the plain form.

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

/** Public typed shape emitted into codegen.
 *
 *  The credentialed URL is INCLUDED so consumers in the same user
 *  app process can dial. The manifest projection (substrate-level)
 *  strips it via the secret-redactor pattern — codegen and manifest
 *  are different artifacts. */
export interface PostgresConnectionBindings {
	readonly name: string;
	readonly host: string;
	readonly port: number;
	readonly user: string;
	/** Sensitive — never crosses to the on-disk manifest. */
	readonly password: string;
	readonly databases: ReadonlyArray<string>;
	/** Cluster-level URL with credentials. */
	readonly url: string;
	/** Cluster-level URL without credentials — manifest-safe. */
	readonly plainUrl: string;
	/** First (bootstrap) database name. Convenience for single-DB apps. */
	readonly database: string;
	/** Per-database credentialed URL composer is NOT included on the
	 *  emitted shape — codegen output is a static record, not a closure.
	 *  Consumers compose `${url}/${db}` themselves, or import the helper
	 *  from the plugin's runtime surface. */
}
